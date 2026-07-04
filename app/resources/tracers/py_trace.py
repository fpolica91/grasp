#!/usr/bin/env python3
"""grasp Python reference tracer — emits a Trace v1 JSON document on stdout.

A skill asset the AGENT runs (not an engine grasp ships). It sys.settrace's a real
call to `module.func(**input)` scoped to the repo, records every in-scope frame with
its args/return/timing/source, and prints one Trace v1 doc. Honesty: an import/attach
failure is reported as `unobservable` — never as a frame or a thrown-error.

  python3 py_trace.py --repo REPO --entry module.func --input '{"s":"hello"}'
"""
import argparse, json, os, sys, time, uuid


def _repr(v):
    try:
        s = repr(v)
    except Exception:
        s = f"<unreprable {type(v).__name__}>"
    return s if len(s) <= 400 else s[:400] + "…"


def _jsonable(v):
    try:
        json.dumps(v)
        return v
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--entry", required=True, help="module.func")
    ap.add_argument("--input", default="{}")
    a = ap.parse_args()
    repo = os.path.abspath(a.repo)
    kwargs = json.loads(a.input or "{}")
    # entry is "path/to/file.py:func" (robust on repos without __init__.py) OR "module.func"
    path_form = ":" in a.entry
    if path_form:
        _fp, _, func_name = a.entry.rpartition(":")
        mod_name = None
        mod_file = os.path.join(repo, _fp)
    else:
        mod_name, _, func_name = a.entry.rpartition(".")
        mod_file = None

    doc = {
        "grasp_trace_version": "1", "id": uuid.uuid4().hex, "createdAt": 0,
        "entry": a.entry, "language": "python", "how": f"settrace on {a.entry}",
        "gitRef": None, "input": kwargs, "status": "unobservable",
        "frames": [], "ret": None, "threw": None, "durationMs": None,
        "stdout": "", "stderr": "", "unobservable": None,
    }

    sys.path.insert(0, repo)
    sys.dont_write_bytecode = True  # never leave .pyc; avoid stale-cache reads on rapid edits
    import importlib
    importlib.invalidate_caches()
    try:
        if path_form:
            import importlib.util as _u
            _spec = _u.spec_from_file_location("__grasp_target__", mod_file)
            mod = _u.module_from_spec(_spec)
            _spec.loader.exec_module(mod)
        else:
            mod = importlib.import_module(mod_name)
        fn = getattr(mod, func_name)
    except Exception as e:  # import/resolution = config fact, NOT behavior
        doc["unobservable"] = {"reason": f"{type(e).__name__}: {e}",
                               "hint": "check the entrypoint module.func and that its imports resolve"}
        print(json.dumps(doc)); return

    frames, stack, seq = [], [], [0]

    def gtrace(frame, event, arg):
        if event != "call":
            return None
        fpath = os.path.abspath(frame.f_code.co_filename)
        if not fpath.startswith(repo):
            return None
        seq[0] += 1
        rec = {
            "id": f"f{seq[0]}",
            "parent": stack[-1]["id"] if stack else None,
            "seq": seq[0], "depth": len(stack), "fn": frame.f_code.co_name,
            "file": os.path.relpath(fpath, repo), "line": frame.f_code.co_firstlineno,
            "callLine": frame.f_back.f_lineno if frame.f_back else None,
            "args": [{"name": k, "repr": _repr(v), "json": _jsonable(v)}
                     for k, v in list(frame.f_locals.items())[:24]],
            "ret": None, "threw": None, "durMs": 0.0, "language": "python",
            "_t": time.perf_counter(),
        }
        stack.append(rec)
        return ltrace

    def ltrace(frame, event, arg):
        if event == "return" and stack:
            rec = stack.pop()
            rec["ret"] = {"name": "return", "repr": _repr(arg), "json": _jsonable(arg)}
            rec["durMs"] = round((time.perf_counter() - rec.pop("_t")) * 1000, 3)
            frames.append(rec)
        elif event == "exception" and stack:
            et, ev = arg[0], arg[1]
            stack[-1]["threw"] = {"type": getattr(et, "__name__", str(et)), "message": _repr(ev)}
        return ltrace

    import io
    from contextlib import redirect_stdout, redirect_stderr
    out, err = io.StringIO(), io.StringIO()
    t0 = time.perf_counter()
    sys.settrace(gtrace)
    result, thrown = None, None
    try:
        with redirect_stdout(out), redirect_stderr(err):
            result = fn(**kwargs)
    except Exception as e:
        thrown = {"type": type(e).__name__, "message": _repr(e)}
    finally:
        sys.settrace(None)
        # any frames still open (exception unwound) get flushed durationless
        while stack:
            rec = stack.pop(); rec.pop("_t", None)
            frames.append(rec)

    frames.sort(key=lambda f: f["seq"])
    doc["frames"] = frames
    doc["durationMs"] = round((time.perf_counter() - t0) * 1000, 3)
    doc["stdout"] = out.getvalue()[:8000]
    doc["stderr"] = err.getvalue()[:8000]
    root = next((f for f in frames if f["parent"] is None), None)
    if thrown:
        doc["status"], doc["threw"] = "threw", thrown
    else:
        doc["status"] = "returned"
        doc["ret"] = {"name": "return", "repr": _repr(result), "json": _jsonable(result)}
    print(json.dumps(doc))


if __name__ == "__main__":
    main()
