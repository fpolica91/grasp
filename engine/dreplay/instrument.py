"""Interior instrumentation — turn ONE real execution into an observed Flow (spec §3/§8.2).

``run_flow`` runs the entrypoint in a worker subprocess with ``sys.settrace`` +
``threading.settrace`` scoped to the target package, captures call/return events
with bound values + durations, AST-reads module constants/funcs, and reduces all
of it into a :class:`~dreplay.flow.Flow` of observed :class:`~dreplay.flow.Node`\\s.

**Runs the code FOR REAL (Mode A).** The instrument's job is to observe what the
code *actually* does to business objects, so — unlike the fuzzer/differ — it does
NOT apply the egress wall: real network and the real environment are in scope by
design (an egress wall would turn every real DB/API call into a "blocked" boundary
instead of the behavior we want to observe). There is still a subprocess boundary
(crash/state isolation from dreplay), but no network isolation. **Never run this on
untrusted code.** The fuzzer/differ (Mode B) keep their seccomp wall.

Honesty rules (docs/what-this-is.md §1):
* every operand is ``observed`` (from the trace / AST constants) or ``unknown`` —
  NEVER guessed. Durations are measured; counts are counted; constants are read.
* a node the trace cannot see is not synthesized. Per-thread work is traced via
  ``threading.settrace`` so concurrent phases are observable; anything still
  unobservable is marked ``unknown``, not invented.
* scope = the target package dir, so stdlib/framework plumbing never becomes a node
  in the first place (the relevance layer starts narrow; the classifier (FL3)
  refines business_meaningful on top).
"""
from __future__ import annotations

import ast
import importlib
import importlib.util
import io
import json
import os
import statistics
import subprocess
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
from typing import Any

from . import _seccomp, containment
from .canonical import canonicalize, _scrub_addresses
from .egress import install_interception
from .flow import BusinessObject, Flow, Mode, Node, Operand
from .types import ImplSpec, Policy

_DREPLAY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Vocabulary scans import the target repo's own modules (real code execution) —
# memoize per target-path set so one CLI run (esp. a fuzz pass of N variants)
# scans at most once.
_VOCAB_CACHE: dict[tuple, Any] = {}

# Field names a domain expert can call right or wrong. Under the inverted classifier
# (spec §4: denylist-seeded, default-show) these are the DOMINANCE set (style/badge),
# NOT the filter — a field shows unless it is PLUMBING (below). Kept disjoint from
# _PLUMBING_FIELDS so dominant fields can never be suppressed.
_DOMINANT_FIELDS = {
    "owner", "name", "status", "amount", "token", "id", "email", "tenant",
    "role", "price", "qty", "quantity", "currency", "user", "user_id", "org",
    "organization", "saved", "paid", "active", "enabled", "plan", "tier",
}

# Conservative PLUMBING field-name denylist. HIGH-CONFIDENCE framework internals only
# (dunder attrs, ORM/SQLAlchemy, pydantic, HTTP request/response, logging/metrics,
# connection/pool). Generic words that COULD be business in some domain (data, value,
# result, payload, body, raw, scope, state, schema, query, type, kind, key) are
# deliberately EXCLUDED — they stay shown (miss is the worst failure; noise is second).
_PLUMBING_FIELDS = {
    "self", "cls", "args", "kwargs", "kwds", "params", "environ", "ctx", "context",
    "config", "cfg", "settings", "opts", "options", "env", "metadata", "meta",
    "extra", "attrs", "annotations", "slots", "base",
    "__dict__", "__class__", "__module__", "__weakref__", "__doc__", "__fields__",
    "__fields_set__", "__pydantic_extra__", "__pydantic_fields_set__",
    "__pydantic_validator__", "__pydantic_serializer__", "__dataclass_fields__",
    "__dataclass_params__", "__match_args__", "__wrapped__",
    "model_fields", "model_config", "model_dump", "model_validate", "model_construct",
    "model_post_init", "model_extra", "model_copy", "field_validator",
    "model_validator", "root_validator", "alias", "aliases", "discriminator",
    "_sa_instance_state", "_sa_class_manager", "_sa_registry", "_sa_init",
    "_sa_object_session", "__mapper_args__", "__tablename__", "__table__",
    "__table_args__", "registry", "mapper", "declarative_base", "sessionmaker",
    "scoped_session", "create_engine", "engine", "conn", "connection", "cursor",
    "session", "transaction", "txn", "queryset", "filter", "filter_by",
    "whereclause", "execute", "commit", "rollback", "flush", "savepoint", "aliased",
    "request", "response", "headers", "cookies", "status_code", "method", "host",
    "port", "scheme", "mimetype", "content_type", "remote_addr", "charset",
    "encoding", "reason_phrase",
    "logger", "logging", "log_level", "tracer", "span", "span_id", "trace_id",
    "metric", "metrics", "counter", "gauge", "histogram", "telemetry",
    "instrumentation", "level", "levelname",
    "pool", "pool_size", "max_overflow", "pool_timeout", "acquire", "release",
    "checkout", "checkin", "dispose", "max_workers", "concurrency", "workers",
    "executor", "thread", "thread_id", "task_id", "future", "lock", "mutex",
    "semaphore",
    "marshalled", "pickled", "serialized", "exclude", "include", "by_alias",
    "round_trip",
}
assert _DOMINANT_FIELDS.isdisjoint(_PLUMBING_FIELDS), "dominant field leaked into plumbing denylist"

# A dict binding MORE than this many non-plumbing fields is a DATA STRUCTURE (rule
# table, mapping, cache), not a business object → its fields are not bound (the node
# can still be meaningful via kind). Guards the inversion against data-table noise.
_DATA_STRUCTURE_THRESHOLD = 8

# Plumbing LABEL patterns used by _is_plumbing_label(): a node whose label matches is
# collapsed EVEN IF it binds business-shaped fields (e.g. __init__ binding self.amount,
# to_dict binding the dict). DELIBERATELY SMALL + DISTINCTIVE — dunders + conversion
# verbs only. Generic verbs (execute/commit/close/select/filter/join/render) are
# intentionally ABSENT: as substrings they would false-collapse business names like
# `execute_order`/`select_plan` (misses). Those collapse via the no-operand rule.
_PLUMBING_LABEL_PATTERNS = (
    "to_dict", "asdict", "astuple", "from_dict", "to_json", "from_json", "to_jsonable",
    "jsonable_encoder", "as_json", "to_string", "from_string", "to_yaml", "from_yaml",
    "to_orm", "from_orm", "serialize", "serialise", "deserialize", "deserialise",
    "marshal", "unmarshal", "pickle", "model_dump", "model_validate", "model_construct",
    "model_copy", "model_json_schema", "parse_obj", "parse_raw", "parse_file",
    "schema_json",
)


def _is_plumbing_label(label: str) -> bool:
    """True for dunders + conversion verbs — safe to suppress even when they bind
    business-shaped fields. Dunders by prefix; conversion verbs by substring."""
    return label.startswith("__") or any(p in label for p in _PLUMBING_LABEL_PATTERNS)


def _bind_field(name: str, business: set[str], plumbing: set[str], has_vocab: bool) -> bool:
    """Should this field name be bound as a business operand?

    Two modes (spec §4 — denylist-seeded, default-show — applies ONLY when the repo's
    own models gave us a vocabulary):

    * VOCAB mode (has_vocab=True): field must be in the derived business set (the
      repo's own model fields ∪ dominant names) AND not plumbing/dunder. This is
      schema-derived precision — works on any domain because the domain declares its
      objects.

    * NON-VOCAB mode (has_vocab=False, no importable models): field must be in the
      DOMINANT set (the 23 classic business names). This is deliberately CONSERVATIVE
      — it under-shows unrecognized domain fields, but it prevents the noise explosion
      the denylist caused on no-models repos (pycasbin: 140-node default view). The
      under-show tradeoff (miss > noise per spec) is acceptable because a repo with no
      declared models has no machine-readable vocabulary to derive from — name-guessing
      can't help.
    """
    if not name or name.startswith("__"):
        return False
    if has_vocab:
        return name not in plumbing and name in business
    # Non-vocab conservative: dominant fields only (avoids the pycasbin explosion).
    return name in _DOMINANT_FIELDS

_VERDICT_WORDS = ("bug", "risk", "vulnerab", "exceed", "broken", "wrong", "fail", "bad", "danger")


# --------------------------------------------------------------------------- #
# Parent orchestrator
# --------------------------------------------------------------------------- #
def run_flow(
    *,
    spec: ImplSpec,
    kwargs: dict,
    mode: Mode = "instant",
    seed: int | None = None,
    policy: Policy | None = None,
    python_path: list[str] | None = None,
    business_fields: tuple[str, ...] = (),
    walled: bool = False,
    interpreter: str | None = None,
) -> Flow:
    # ``interpreter`` (the recipe layer's interpreter-swap): run the worker under a
    # provisioned venv that has the TARGET repo's deps installed, instead of
    # dreplay's own interpreter. The worker bootstrap prepends _DREPLAY_ROOT to
    # sys.path, and every worker-side dreplay module is stdlib-only, so the target
    # venv can still `import dreplay` while its own deps satisfy the entrypoint's
    # imports. Ignored under the frozen (PyInstaller) binary, which has no source
    # tree to import from.
    #
    # Mode A (walled=False) observes REAL behavior: the code runs for real (real
    # network + real env), by design — no seccomp/netns wall, no env scrub. An
    # egress wall would turn every real DB/API call into a "blocked" boundary
    # instead of the actual behavior we are here to observe. There is still a
    # subprocess boundary (crash/state isolation from dreplay). NEVER run on
    # untrusted code.
    #
    # walled=True is Mode B's stance (docs/what-this-is.md: the fuzzer keeps its
    # kernel egress wall — fuzzing multiplies side-effects ×N variants, exactly
    # the runaway the wall prevents). Kernel containment only: the caller
    # (flow_fuzz) must refuse BEFORE calling us when no kernel wall exists; here
    # we arm what detection found and the worker fails closed if it cannot. The
    # wall denies NETWORK egress only — filesystem/local side-effects and the
    # real environment stay real (imports/config must still work).
    detected = containment.detect() if walled else None
    policy = replace(policy or Policy(), egress="denied" if walled else "full")
    level = detected.level if walled else "none"
    paths = list(python_path or [_DREPLAY_ROOT])
    # src-layout parity with the differ sandbox (sandbox.py does the same): a
    # package often lives under <repo>/src, not the repo root — probe and add,
    # for imports only.
    for p in list(paths):
        src = os.path.join(p, "src")
        if os.path.isdir(src) and src not in paths:
            paths.insert(0, src)
    if _DREPLAY_ROOT not in paths:
        paths.insert(0, _DREPLAY_ROOT)

    env = dict(os.environ)  # real environment — real calls/imports must work
    job = {
        "module": spec.module,
        "func": spec.func,
        "kwargs": kwargs,
        "policy": _policy_to_dict(policy),
        "python_path": paths,
        # In-worker seccomp when that is the containment this host offers (netns,
        # when available, is applied as a command prefix instead — see below).
        "seccomp": bool(walled and detected.level == "seccomp"),
    }
    # When frozen (PyInstaller binary), re-invoke the binary with --_worker
    # (the binary's _entry.py detects this and runs _traced_worker). When running
    # from source, use python -c with the bootstrap code.
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--_worker"]
    else:
        worker_code = (
            f"import sys; sys.path[0:0]={[_DREPLAY_ROOT]!r}; "
            "from dreplay.instrument import _traced_worker; _traced_worker()"
        )
        cmd = [interpreter or sys.executable, "-c", worker_code]

    if walled:
        # Kernel netns isolation, where this host actually grants it: wrap the
        # worker in its own network namespace (empty prefix otherwise).
        cmd = containment.worker_prefix(detected, policy.egress) + cmd

    try:
        proc = subprocess.run(
            cmd, input=json.dumps(job), capture_output=True, text=True,
            env=env, timeout=policy.timeout_s,
        )
        data = json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        return _error_flow(spec, mode, f"worker failed: {type(exc).__name__}: {exc}", level)

    from .vocabulary import derive_vocabulary_detailed, VocabularyResult
    del business_fields
    target_paths = [p for p in paths
                    if os.path.abspath(p) != _DREPLAY_ROOT
                    and "site-packages" not in p and "dist-packages" not in p]
    # Memoized per process: the scan imports the target's modules (real code),
    # so a fuzz pass of N variants must not re-execute the repo N times.
    cache_key = tuple(sorted(os.path.abspath(p) for p in target_paths))
    vocab_result = _VOCAB_CACHE.get(cache_key)
    if vocab_result is None:
        try:
            vocab_result = (derive_vocabulary_detailed(target_paths) if target_paths
                            else VocabularyResult(set(), 0, 0, 0))
        except Exception:  # noqa: BLE001
            vocab_result = VocabularyResult(set(), 0, 0, 0)
        _VOCAB_CACHE[cache_key] = vocab_result

    return _reduce(spec, kwargs, mode, seed, data, level, vocab_result)


# --------------------------------------------------------------------------- #
# Worker (subprocess) — trace + emit raw observed facts
# --------------------------------------------------------------------------- #
def _traced_worker() -> None:
    import threading

    job = json.load(sys.stdin)
    sys.path[0:0] = job["python_path"]
    policy = Policy(egress=job["policy"]["egress"], clock=job["policy"]["clock"],
                    rng_seed=job["policy"]["rng_seed"], float_tol=job["policy"]["float_tol"])

    outbound: list[dict] = []
    expensive: dict[str, int] = {}
    install_interception(policy, outbound, expensive)
    _inject_clock(policy.clock)
    _inject_rng(policy.rng_seed)

    mod_file = _find_module_file(job["module"])
    target_dir = os.path.dirname(os.path.abspath(mod_file)) if mod_file else None
    constants, defined_funcs, auth_calls = ({}, [], {})
    if mod_file and os.path.isfile(mod_file):
        constants, defined_funcs, auth_calls = _ast_read(mod_file)

    events: list[dict] = []
    stack: list[dict] = []

    def _in_scope(frame) -> bool:
        if target_dir is None:
            return False
        return os.path.abspath(frame.f_code.co_filename).startswith(target_dir)

    def _global_trace(frame, event, arg):
        if event != "call" or not _in_scope(frame):
            return None
        rec = {
            "func": frame.f_code.co_name,
            "locals": _safe_locals(frame.f_locals),
            "t_enter": time.time(),
        }
        stack.append(rec)
        return _local_trace

    def _local_trace(frame, event, arg):
        if event == "return" and stack:
            rec = stack.pop()
            rec["return"] = _safe_repr(arg)
            rec["dur"] = time.time() - rec["t_enter"]
            events.append(rec)
        return _local_trace

    # seccomp LAST (after our own setup), fail-closed if it can't arm.
    if job.get("seccomp") and not _seccomp.install():
        json.dump({"worker_error": "seccomp egress filter could not be armed; refusing to run unprotected"},
                  sys.stdout)
        return

    result: dict[str, Any] = {"events": [], "constants": constants, "defined_funcs": defined_funcs,
                              "auth_calls": {k: sorted(v) for k, v in auth_calls.items()},
                              "outbound": outbound, "return": None, "exception": None}
    out_buf, err_buf = io.StringIO(), io.StringIO()

    # Resolve the entrypoint FIRST, in its own guard. An import/resolution failure
    # means NOTHING was observed — it is a configuration/environment fact, not
    # target behavior, so it must never be framed as an observed thrown-error
    # ("— intended?"). Mirrors the differ's entrypoint_error refuse. A raise from
    # the resolved function (below) IS observed behavior and stays thrown-error.
    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            mod = importlib.import_module(job["module"])
            fn = getattr(mod, job["func"])
    except Exception as exc:  # noqa: BLE001
        json.dump({"entrypoint_error": f"{type(exc).__name__}: {exc}"},
                  sys.stdout, default=repr)
        return

    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            # Arm the trace AFTER import completes — only trace the fn execution, NOT
            # the import (which fires model-class definitions, validator setup, importlib
            # internals — all noise that flooded the default view on real repos:
            # 19/21 spurious nodes on the Pydantic repo, 45/45 on the dataclass repo).
            sys.settrace(_global_trace)
            threading.settrace(_global_trace)  # so pool/worker threads are observed too
            ret = fn(**job["kwargs"])
            sys.settrace(None)
            threading.settrace(None)
        result["return"] = canonicalize(ret, float_tol=policy.float_tol).shape
    except Exception as exc:  # noqa: BLE001
        sys.settrace(None)
        threading.settrace(None)
        result["exception"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        sys.settrace(None)
        threading.settrace(None)

    result["events"] = events
    result["stdout"] = out_buf.getvalue()
    result["stderr"] = err_buf.getvalue()
    # default=repr makes the emission TOTAL: one non-JSON-serializable value must
    # not truncate the protocol document mid-stream (a truncated document became
    # an instrumentation-error that blamed the user's entrypoint).
    json.dump(result, sys.stdout, default=repr)


def _find_module_file(module: str) -> str | None:
    try:
        spec = importlib.util.find_spec(module)
        return spec.origin if spec and spec.origin else None
    except (ImportError, ValueError):
        return None


def _ast_read(mod_file: str) -> tuple[dict, list[str], dict]:
    """Read module-level CONSTANT assignments, function names, and (per function)
    the auth-y funcs its body CALLS — from source. Observed facts (literally in the
    code), not guesses.

    The per-function auth-call map scopes "auth not executed" to auth checks the
    entrypoint's OWN body references (even conditionally), so an unrelated auth
    func defined elsewhere in the module is NOT flagged as a false positive.
    """
    constants: dict[str, Any] = {}
    funcdefs: dict[str, ast.FunctionDef] = {}
    auth_calls: dict[str, set[str]] = {}
    try:
        tree = ast.parse(open(mod_file, encoding="utf-8").read())
    except (OSError, SyntaxError):
        return constants, list(funcdefs), auth_calls
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            funcdefs[node.name] = node
        elif isinstance(node, ast.Assign):
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                if name.isupper():  # module convention: UPPER = constant
                    try:
                        # _safe_canon: literal_eval happily yields sets/bytes/
                        # tuples — JSON-unserializable values that would truncate
                        # the worker's protocol document mid-stream. Numerics
                        # (what the timeout math consumes) pass through intact.
                        constants[name] = _safe_canon(ast.literal_eval(node.value))
                    except ValueError:
                        pass
    for fname, fdef in funcdefs.items():
        calls: set[str] = set()
        for sub in ast.walk(fdef):
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name):
                if sub.func.id in funcdefs and _looks_auth(sub.func.id):
                    calls.add(sub.func.id)
        if calls:
            auth_calls[fname] = calls
    return constants, list(funcdefs), auth_calls


import types as _types

_MAX_CANON_SIZE = 2000  # chars — beyond this, summarize instead of expanding


def _safe_canon(v: Any) -> Any:
    """Canonicalize with a size cap: if the result is huge (framework-introspection
    metadata like __dataclass_fields__ with _MISSING_TYPE, dunder method tables),
    summarize to a placeholder instead of expanding the full descriptor."""
    try:
        shape = canonicalize(v).shape
    except Exception:  # noqa: BLE001
        return "<unreprable>"
    # Skip type/module/function objects — they're not business data, and their
    # canonical form is enormous class-introspection metadata (the root cause of
    # the 8.6MB / 288KB-per-line verbosity on the dataclass repo).
    if isinstance(v, (type, _types.ModuleType, _types.FunctionType,
                      _types.MethodType, _types.BuiltinFunctionType)):
        return f"<{type(v).__name__}: {getattr(v, '__name__', '?')}>"
    # Cap the serialized size — large dicts/lists are data tables, not operands.
    try:
        s = json.dumps(shape, default=str)
        if len(s) > _MAX_CANON_SIZE:
            return f"<truncated: {type(v).__name__}, {len(s)} chars>"
    except Exception:  # noqa: BLE001
        pass
    return shape


def _safe_locals(locals_: dict) -> dict:
    out: dict[str, Any] = {}
    for k, v in locals_.items():
        if k.startswith("__"):
            continue
        out[k] = _safe_canon(v)
    return out


def _safe_repr(v: Any) -> Any:
    return _safe_canon(v)


def _inject_clock(clock: float | None) -> None:
    if clock is None:
        return
    import time as _t
    _t.time = lambda: clock  # type: ignore[assignment]
    _t.time_ns = lambda: int(clock * 1e9)  # type: ignore[assignment]
    # Freeze datetime.now/utcnow too. datetime.datetime is C-immutable, but the
    # module namespace is mutable, so we subclass and reassign datetime.datetime.
    # Affects code reaching datetime via the module after this patch (the common
    # case, incl. `from datetime import datetime` in modules imported after it).
    import datetime as _dt

    class _FrozenDT(_dt.datetime):  # type: ignore[misc, valid-type]
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return _dt.datetime.fromtimestamp(clock, tz) if tz else _dt.datetime.fromtimestamp(clock)

        @classmethod
        def utcnow(cls):  # type: ignore[override]
            return _dt.datetime.fromtimestamp(clock, _dt.timezone.utc).replace(tzinfo=None)

    _dt.datetime = _FrozenDT  # type: ignore[assignment]


def _inject_rng(seed: int | None) -> None:
    if seed is None:
        return
    import random
    random.seed(seed)


def _policy_to_dict(p: Policy) -> dict:
    return {"egress": p.egress, "clock": p.clock, "rng_seed": p.rng_seed, "float_tol": p.float_tol}


# --------------------------------------------------------------------------- #
# Reduction — observed facts → Flow of Nodes (deterministic; no synthesis)
# --------------------------------------------------------------------------- #
_EVIDENCE_CAP = 2000  # chars per stream — beyond this, truncate (with a count)


def _run_evidence(data: dict) -> str | None:
    """The run's OBSERVED output (stdout + stderr) as display-only evidence.

    Returned as the terminal node's ``raw_detail`` (shown on expand, in the TUI and
    ``to_html``). It is NOT an operand and NOT part of node identity, so it never
    enters the flow-diff as a compared behavior — it is evidence, not a claim.
    Address-scrubbed so it stays reproducible (principle #4: same code + inputs →
    same observed flow; the worker already freezes the clock and seeds the RNG).
    Returns ``None`` when the run produced no output, so flows for silent code are
    byte-identical to before this change.
    """
    parts: list[str] = []
    for name in ("stdout", "stderr"):
        text = data.get(name) or ""
        if not text.strip():
            continue
        scrubbed = _scrub_addresses(text)
        if len(scrubbed) > _EVIDENCE_CAP:
            scrubbed = scrubbed[:_EVIDENCE_CAP] + f"\n… (+{len(scrubbed) - _EVIDENCE_CAP} more chars)"
        n_lines = len(scrubbed.splitlines())
        parts.append(f"--- {name} ({n_lines} line(s), observed) ---\n{scrubbed.rstrip()}")
    return "\n".join(parts) if parts else None


def _is_tagged_scalar(shape: dict) -> bool:
    """True if ``shape`` is a canonical scalar encoding (a single ``__tag__`` key:
    ``__repr__``/``__set__``/``__bytes__``/``__iso__``/``__float__``/``__enum__``),
    not a business-object field dict. Such a value IS the return, not fields of it."""
    if len(shape) != 1:
        return False
    k = next(iter(shape))
    return isinstance(k, str) and k.startswith("__") and k.endswith("__") and len(k) > 4


def _reduce(spec: ImplSpec, kwargs: dict, mode: Mode, seed: int | None,
            data: dict, containment_level: str, vocab_result=None) -> Flow:
    vocab_fields = vocab_result.fields if vocab_result else set()
    business = _DOMINANT_FIELDS | vocab_fields
    has_vocab = bool(vocab_fields)
    nodes: list[Node] = []
    entrypoint = f"{spec.module}.{spec.func}"

    if data.get("worker_error"):
        return _error_flow(spec, mode, data["worker_error"], containment_level)

    if data.get("entrypoint_error"):
        # The entrypoint never resolved — nothing ran, nothing was observed. A
        # config/environment fact, NOT target behavior (that would be a
        # thrown-error). Framed as such, with an actionable question.
        return _error_flow(
            spec, mode,
            f"the entrypoint could not be imported/resolved: {data['entrypoint_error']}",
            containment_level,
            open_question=(
                f"'{spec.module}.{spec.func}' did not resolve "
                f"({data['entrypoint_error']}) — is --entrypoint module.func importable "
                "from --repo (src/ layouts are probed automatically), and are the "
                "repo's dependencies installed in this interpreter?"
            ),
        )

    events = data.get("events", [])
    constants = data.get("constants", {})
    defined_funcs = data.get("defined_funcs", [])
    auth_calls = data.get("auth_calls", {})  # {func: auth funcs its body calls}

    # input node
    input_ops = tuple(
        Operand(name=k, value=v, provenance="observed") for k, v in kwargs.items()
    )
    nodes.append(Node(kind="input", label=spec.func, operands=input_ops, business_meaningful=True,
                      open_question=None))

    # auth-checks the ENTRYPOINT's own body calls (conditionally) but did NOT fire
    # on this run — scoped to the entrypoint's references so an unrelated auth func
    # defined elsewhere in the module is not a false positive.
    called = {e["func"] for e in events}
    for fn in auth_calls.get(spec.func, set()):
        if fn not in called:
            nodes.append(Node(
                kind="auth_check", label=fn,
                operands=(Operand(name="auth_state", value="not_executed", provenance="observed"),),
                business_meaningful=True,
                open_question=f"auth check '{fn}' is defined but was NOT executed on this path — intended?",
            ))

    # one node per traced in-scope call (excluding the entrypoint frame)
    for e in events:
        if e["func"] == spec.func:
            continue
        kind = _classify_kind(e["func"])
        ops = _extract_operands(e, _PLUMBING_FIELDS, business, has_vocab)
        # INVERTED classifier (spec §4): show a call if it binds a non-plumbing
        # business field AND isn't a plumbing label (dunder/conversion verb), OR if
        # its kind is always-meaningful (the act itself is the business fact). No-
        # operand calls (_inc) and plumbing-labeled binders (__init__, to_dict) collapse.
        meaningful = (bool(ops) and not _is_plumbing_label(e["func"])) or kind in (
            "db_write", "external_call", "auth_check")
        nodes.append(Node(
            kind=kind, label=e["func"], operands=tuple(ops),
            business_meaningful=meaningful,
            open_question=_question_for(kind, ops) if meaningful else None,
        ))

    # timeout-math operands, only when the pattern is genuinely present
    tnode = _timeout_node(events, constants)
    if tnode is not None:
        nodes.append(tnode)

    # entrypoint write-effect: if the entrypoint binds a write-indicator field
    # (saved/written/persisted/...) on a returned business object, that IS a write —
    # surface it as a db_write node (observed from the entrypoint's own effect).
    ewn = _entrypoint_write_node(spec.func, data.get("return"), business, _PLUMBING_FIELDS, has_vocab)
    if ewn is not None:
        nodes.append(ewn)

    # Observed run output (stdout/stderr) as evidence on the terminal node — "show
    # what happened so you can confirm it" (the moat: certain about observed facts).
    # It rides in raw_detail (display-only, shown on expand): NOT an operand and NOT
    # part of node identity, so it never enters the flow-diff as a compared behavior,
    # and it is address-scrubbed so it stays reproducible.
    run_detail = _run_evidence(data)

    exc = data.get("exception")
    if exc:
        # thrown-error node (observed): the run raised instead of returning. An
        # empty return node for a run that never returned would be a fabricated
        # fact — surface the captured exception and emit NO return node. Same
        # node shape every adapter pins: kind=other, label=thrown-error.
        nodes.append(Node(
            kind="other", label="thrown-error", provenance="observed",
            operands=(
                Operand(name="type", value=exc.get("type"), provenance="observed"),
                Operand(name="message", value=exc.get("message"), provenance="observed"),
            ),
            business_meaningful=True,
            open_question=(
                f"the run raised {exc.get('type')}: {exc.get('message')} — intended?"
            ),
            raw_detail=run_detail,
        ))
    else:
        # return node
        ret = data.get("return")
        ret_ops: tuple[Operand, ...] = ()
        if isinstance(ret, dict) and _is_tagged_scalar(ret):
            # A canonical-tagged scalar ({'__repr__': ...} for a generator/opaque
            # object, {'__set__': ...}, {'__iso__': ...}, ...) is the OUTPUT itself,
            # NOT a business-object field dict. The dunder filter below would drop
            # it and silently render an empty return for a real (e.g. lazy-iterator)
            # return value. Surface it as the observed <return>.
            (tag, tagval), = ret.items()
            ret_ops = (Operand(name="<return>", value=tagval, provenance="observed"),)
        elif isinstance(ret, dict):
            # The return node is the OUTPUT — always shown in full (non-dunder, non-plumbing).
            # Does NOT use _bind_field (which is for INTERIOR calls and may be vocab/dominant
            # gated). The return value is the observable result, regardless of its field names.
            ret_ops = tuple(
                Operand(name=k, value=v, provenance="observed")
                for k, v in ret.items()
                if not str(k).startswith("__") and k not in _PLUMBING_FIELDS
            )
        elif ret is not None:
            ret_ops = (Operand(name="<return>", value=ret, provenance="observed"),)
        nodes.append(Node(kind="return", label=spec.func, operands=ret_ops,
                          business_meaningful=True, raw_detail=run_detail))

    return Flow(entrypoint=entrypoint, mode=mode, nodes=tuple(nodes), seed=seed,
                containment_level=containment_level,
                classifier_mode=(vocab_result.mode if vocab_result else "non_vocab"),
                vocab_size=len(vocab_fields),
                fallback_reason=(vocab_result.fallback_reason if vocab_result else None))


def _extract_operands(event: dict, plumbing: set[str], business: set[str],
                      has_vocab: bool) -> list[Operand]:
    """Business operands observed at this call: fields of dict/object VALUES that pass
    ``_bind_field`` (non-dunder, non-plumbing; and, when the repo's model vocabulary
    was derived, in that vocabulary). Scalar locals are never bound. A dict binding
    more than _DATA_STRUCTURE_THRESHOLD bound fields is a data table → skipped."""
    ops: list[Operand] = []
    seen: set[tuple] = set()

    def _add(name: str, value: Any) -> None:
        key = (name, json.dumps(value, sort_keys=True, default=str))
        if key in seen:
            return
        seen.add(key)
        ops.append(Operand(name=name, value=value, provenance="observed"))

    for container in (event.get("locals"), event.get("return")):
        if isinstance(container, dict):
            for _k, v in container.items():
                if isinstance(v, dict):
                    biz = {fk: fv for fk, fv in v.items()
                           if _bind_field(fk, business, plumbing, has_vocab)}
                    if len(biz) > _DATA_STRUCTURE_THRESHOLD:
                        continue  # data table (rule/mapping/cache), not a business object
                    for fk, fv in biz.items():
                        _add(fk, fv)
    return ops


def _classify_kind(name: str) -> str:
    n = name.lower()
    if _looks_auth(n):
        return "auth_check"
    # Removed "write" — too generic (RWLock._write, file.write are not db writes).
    # Removed "token" from _looks_auth — too generic (_extract_tokens is a parser).
    if any(s in n for s in ("save", "insert", "create", "persist", "post", "upsert", "store")):
        return "db_write"
    if any(s in n for s in ("get", "fetch", "read", "load", "select")):
        return "db_read"
    if any(s in n for s in ("request", "http", "call_api", "charge", "send")):
        return "external_call"
    if "valid" in n or "parse" in n:
        return "validation"
    return "transform"


def _looks_auth(name: str) -> bool:
    n = name.lower()
    # Removed "token" — _extract_tokens / get_params_token are parsers, not auth checks.
    return any(s in n for s in ("auth", "permission", "login", "verify", "authorize"))


def _timeout_node(events: list[dict], constants: dict) -> Node | None:
    """If a repeated-phase + timeout-constant pattern is present, surface the
    timeout-math operands. Every figure is observed (counted / measured / read)."""
    timeout_keys = [k for k in constants if "TIMEOUT" in k.upper()]
    # a repeated callee = phases
    counts: dict[str, list[float]] = {}
    for e in events:
        counts.setdefault(e["func"], []).append(e.get("dur", 0.0))
    repeated = [(fn, durs) for fn, durs in counts.items() if len(durs) > 1]
    if not timeout_keys or not repeated:
        return None

    phases = max(len(durs) for _, durs in repeated)
    measured = statistics.median(max(durs) for _, durs in repeated)  # robust per-phase estimate
    configured = constants[timeout_keys[0]]
    concurrency = _first_constant(constants, ("CONCURRENCY", "MAX_WORKERS", "PARALLEL", "WORKERS"))
    serial_floor = phases * measured

    ops = [
        Operand(name="phases", value=phases, provenance="observed"),
        Operand(name="measured_per_phase", value=measured, provenance="observed"),
        Operand(name="serial_floor", value=serial_floor, provenance="observed",
                derived_from="phases × measured_per_phase"),
        Operand(name="configured_timeout", value=configured, provenance="observed"),
    ]
    if concurrency is not None:
        ops.append(Operand(name="concurrency", value=concurrency, provenance="observed"))

    q = (f"{phases} phases (concurrency {concurrency if concurrency is not None else 'unknown'}), "
         f"measured ~{measured:.3g}s each → serial floor ~{serial_floor:.3g}s vs configured timeout "
         f"{configured} — intended?")
    return Node(kind="other", label="timeout-math", operands=tuple(ops),
                business_meaningful=True, open_question=q)


_WRITE_INDICATORS = {"saved", "written", "persisted", "created", "stored",
                     "inserted", "committed", "updated"}


def _entrypoint_write_node(func: str, ret: Any, business: set[str], plumbing: set[str],
                           has_vocab: bool) -> Node | None:
    """If the entrypoint's returned business object carries a write-indicator field,
    that write is an observed fact → a db_write node."""
    if not isinstance(ret, dict):
        return None
    written = {k: v for k, v in ret.items() if k in _WRITE_INDICATORS}
    if not written:
        return None
    ops = tuple(Operand(name=k, value=v, provenance="observed") for k, v in written.items())
    nulls = [k for k, v in ret.items() if v is None and _bind_field(k, business, plumbing, has_vocab)]
    q = f"write binds {', '.join(nulls)} = NULL — intended?" if nulls else None
    return Node(kind="db_write", label=func, operands=ops, business_meaningful=True, open_question=q)


def _first_constant(constants: dict, needles: tuple[str, ...]) -> Any:
    for n in needles:
        for k, v in constants.items():
            if n in k.upper():
                return v
    return None


def _question_for(kind: str, ops: list[Operand]) -> str | None:
    if kind == "db_write":
        nulls = [o.name for o in ops if o.value is None]
        if nulls:
            return f"write binds {', '.join(nulls)} = NULL — intended?"
    return None


def _error_flow(spec: ImplSpec, mode: Mode, message: str, containment_level: str,
                open_question: str | None = None) -> Flow:
    return Flow(
        entrypoint=f"{spec.module}.{spec.func}", mode=mode,
        nodes=(Node(kind="other", label="instrumentation-error", provenance="unknown",
                    operands=(Operand(name="error", value=message, provenance="unknown"),),
                    business_meaningful=True,
                    open_question=open_question or (
                        f"instrumentation could not observe this run: {message} — "
                        "this is a dreplay/environment failure, not observed target behavior"
                    )),),
        containment_level=containment_level,
        # Honest transparency: nothing ran, so the classifier was never applied —
        # do not let the header imply a vocab scan concluded "no models found".
        fallback_reason="run not observed — classifier not applied",
    )
