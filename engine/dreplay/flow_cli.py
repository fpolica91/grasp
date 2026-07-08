"""Mode A — the instant flow CLI (spec §2/§8.5): the daily driver.

Runs ONE real execution of an entrypoint and shows the observed flow. The
**interactive TUI is the default** when stdout is a TTY (the tool's whole premise
is "nobody reads, so the surface has to pull them in"); it **auto-degrades to the
plain text renderer** when there's no TTY (CI, pipes, the Action, redirected
output) — never crashes or hangs waiting for a terminal.

The code runs FOR REAL (no egress wall) so it observes actual behavior — see
``dreplay/instrument.py`` and ``docs/what-this-is.md``. Never run on untrusted code.
The exception is ``--mode fuzz`` (Mode B): it multiplies executions ×N variants, so
it runs under the kernel egress wall by default and refuses on hosts without one;
``--allow-egress`` is the explicit opt-in to fuzz for real.

Exit codes: 0 = flow observed (fuzz: nothing varied); 1 = the run itself raised, or
fuzz/diff surfaced change(s)/variation for review (NOT a verdict); 2 = usage error.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sys

from .flow import observe_flow
from .flow_diff import align_and_diff
from .flow_render import render_diff, render_flow, to_html, to_json
from .types import ImplSpec
from . import worktree


def _tui_available() -> bool:
    try:
        from .flow_tui import _TEXTUAL_AVAILABLE
        return _TEXTUAL_AVAILABLE
    except Exception:
        return False


def _diff_tui_available() -> bool:
    try:
        from .flow_diff_tui import _TEXTUAL_AVAILABLE
        return _TEXTUAL_AVAILABLE
    except Exception:
        return False


def _auto_detect_language(repo: str) -> str:
    """Detect the target language from the repo's root files."""
    try:
        files = set(os.listdir(repo))
    except OSError:
        return "py"
    if "go.mod" in files:
        return "go"
    if any(f.endswith(".csproj") or f.endswith(".sln") for f in files):
        return "csharp"
    if "pom.xml" in files or "build.gradle" in files or any(f.endswith(".java") for f in files):
        return "java"
    if any(f.endswith((".cpp", ".cc", ".cxx", ".C")) or f == "CMakeLists.txt" for f in files):
        return "cpp"
    if "package.json" in files:
        return "ts" if "tsconfig.json" in files else "js"
    return "py"


def _provision_recipe(args, lang: str, repo: str) -> str | None:
    """Resolve + provision a runnable environment for the repo (the recipe layer).

    Returns the interpreter the worker should run under (a venv with the target's
    deps), or None to keep dreplay's own interpreter (today's behavior). Prints the
    provenance so every run states HOW the repo was made runnable (transparency).
    Only the Python path uses a provisioned interpreter; other languages are a
    no-op here. Provisioning executes the repo's build + hits the network, so it is
    opt-in (`--recipe auto|synth`) and, like the instrument, never on untrusted code.
    """
    if args.recipe == "off":
        return None
    if lang not in ("py", "python"):
        print(f"[recipe] --recipe is Python-only; ignored for language '{lang}'", file=sys.stderr)
        return None
    from .recipe import provision, resolve_env
    env = resolve_env(repo, allow_synth=(args.recipe == "synth"))
    try:
        env = provision(env, repo)
    except Exception as exc:  # noqa: BLE001 — a provisioning failure degrades honestly
        print(
            f"[recipe] provisioning failed ({type(exc).__name__}: {exc}); falling back to "
            "the host interpreter — deps may not import. See --recipe.",
            file=sys.stderr,
        )
        return None
    print(f"[recipe] {env.kind}: {env.provenance_note}", file=sys.stderr)
    if env.image_ref and not env.interpreter_path:
        print(
            f"[recipe] image recipe ({env.image_ref}) needs the container sandbox "
            "(not yet wired) — running under the host interpreter for now.",
            file=sys.stderr,
        )
        return None
    return env.interpreter_path


def _trace(language: str, entrypoint: str, kwargs: dict, repo: str, interpreter: str | None = None):
    """Dispatch to the right language adapter. Returns a Flow.

    ``interpreter`` is the recipe layer's provisioned Python (a venv with the
    target's deps) for the Python path; ignored by the other language adapters,
    which use their own toolchains."""
    from .flow import Flow

    if language in ("py", "python"):
        module, _, func = entrypoint.rpartition(".")
        from .flow import observe_flow
        return observe_flow(spec=ImplSpec(module=module, func=func), kwargs=kwargs,
                            python_path=[repo], interpreter=interpreter)
    elif language in ("js", "javascript"):
        from .adapter.node_flow import node_flow
        # Two entrypoint forms:
        #  * path form  "src/colorUtils.cjs:getFontColor" — any of .js/.cjs/.mjs, real
        #    file paths (survives dots in dirs; the only way to express .cjs/.mjs);
        #  * dotted form "svc.createOrder" — resolved to svc.js, falling back to a
        #    sibling .cjs/.mjs when the .js doesn't exist (esbuild output in a
        #    "type": "module" repo is emitted as .cjs).
        if re.search(r"\.(js|cjs|mjs)x?:", entrypoint):
            src, _, func = entrypoint.rpartition(":")
            module_path = os.path.join(repo, src)
        else:
            mod, _, func = entrypoint.rpartition(".")
            module_path = os.path.join(repo, mod.replace(".", "/") + ".js")
            if not os.path.exists(module_path):
                for ext in (".cjs", ".mjs"):
                    alt = os.path.join(repo, mod.replace(".", "/") + ext)
                    if os.path.exists(alt):
                        module_path = alt
                        break
        return node_flow(module_path=module_path, func=func, kwargs=kwargs)
    elif language == "ts":
        from .adapter.ts_flow import ts_flow
        # path form "src/utils/colorUtils.ts:getFontColor" or dotted "mod.func"
        if re.search(r"\.tsx?:", entrypoint):
            src, _, func = entrypoint.rpartition(":")
            source_path = os.path.join(repo, src)
        else:
            mod, _, func = entrypoint.rpartition(".")
            source_path = os.path.join(repo, mod.replace(".", "/") + ".ts")
        return ts_flow(source_path=source_path, func=func, kwargs=kwargs, search_paths=[repo])
    elif language == "cpp":
        source, _, func = entrypoint.rpartition(":")
        if not func:
            source, _, func = entrypoint.rpartition(".")
        from .adapter.cpp_flow import cpp_flow
        return cpp_flow(source_path=os.path.join(repo, source), func=func, kwargs=kwargs)
    elif language == "java":
        cls, _, method = entrypoint.rpartition(".")
        from .adapter.java_flow import java_flow
        return java_flow(src_dir=repo, main_class=cls, func=method, kwargs=kwargs)
    elif language == "go":
        # Go --entrypoint format: "source.go:function" (the .go file path + function)
        source, _, func = entrypoint.rpartition(":")
        if not func:
            source, _, func = entrypoint.rpartition(".")
            source += ".go"
        from .adapter.go_flow import go_flow
        return go_flow(module_path=os.path.join(repo, source), func=func, kwargs=kwargs)
    elif language == "csharp":
        # Namespace.Class.Method → type_name=Namespace.Class, method=Method
        parts = entrypoint.rsplit(".", 1)
        type_name, method = parts[0], parts[1] if len(parts) > 1 else entrypoint
        from .adapter.csharp_flow import csharp_flow
        return csharp_flow(source_path=repo, type_name=type_name, method=method, kwargs=kwargs)
    else:
        raise ValueError(f"unknown language: {language}")


def _run_diff(args, lang: str, kwargs: dict, repo: str) -> int:
    """--diff mode (spec §9.3): observe OLD vs NEW and render the FlowDiff.

    OLD is checked out into a git worktree (so the same entrypoint imports
    old-code); NEW is the current repo working tree. Both are observed FOR REAL
    under the same shared input. The result is rendered as plain text — the TUI
    for the diff is a separate task.

    Exit codes: 0 = no change surfaced; 1 = change(s) surfaced for review (NOT a
    verdict); 2 = usage error (e.g. no --old) or an unobservable side (refuse —
    a diff between an un-run side and a run side would be phantom change, not
    behavior).
    """
    if not args.old:
        print("error: --diff requires --old <ref> (the OLD git ref to diff against)",
              file=sys.stderr)
        return 2

    old_ref = args.old
    # Resolve HEAD of the NEW side so the header names the real commit, not a
    # vague 'working tree' label. Best-effort: fall back to None on any failure.
    new_ref = _resolve_head(repo)

    # `git worktree add` checks out the repo TOPLEVEL. If --repo is a subdir
    # (e.g. a src-layout <clone>/src), the OLD side must trace the SAME relative
    # subpath inside the worktree, or the two sides import from different roots
    # and every node reads as changed on identical code.
    rel = _repo_subpath(repo)

    wt_dir: str | None = None
    try:
        wt_dir = worktree.add(repo, old_ref)
        old_repo = os.path.join(wt_dir, rel) if rel else wt_dir
        print(
            f"dreplay-flow diff: old={old_ref} (worktree)  new={new_ref or 'HEAD'} (repo)  "
            "running the entrypoint FOR REAL on both sides. Never use on untrusted code.",
            file=sys.stderr,
        )
        flow_old = _trace(lang, args.entrypoint, kwargs, old_repo)
        flow_new = _trace(lang, args.entrypoint, kwargs, repo)
    finally:
        if wt_dir is not None:
            worktree.remove(wt_dir, repo_path=repo)

    # Refuse rather than surface phantom change: if EITHER side could not be
    # observed (import/resolution/instrumentation failure — not a target raise,
    # which is an observed thrown-error node), the "diff" would be an artifact of
    # one side not running. Report the failing side honestly and exit 2. Mirrors
    # the differ engine's entrypoint_error refuse (principle: never a false diff).
    for side, fl in (("old", flow_old), ("new", flow_new)):
        err = next((o.value for n in fl.nodes if n.label == "instrumentation-error"
                    for o in n.operands if o.name == "error"), None)
        if err is not None:
            print(
                f"refused: the {side} side could not be observed ({err}). A flow-diff "
                "against an un-run side would be phantom change, not behavior — nothing "
                "is surfaced. Fix the entrypoint/deps and re-run.",
                file=sys.stderr,
            )
            return 2

    flow_diff = align_and_diff(flow_old, flow_new)
    # Attach the real git refs + the actual shared input to the diff. The
    # aligner has neither (it reads _ref off the Flow, which carries none in the
    # observed path, and payloads a synthetic None for synthetic flows). Setting
    # them here makes the header name the sides truthfully and the payload
    # reproducible (principle #3/reproducibility). Frozen dataclass → replace.
    from .canonical import canonicalize
    flow_diff = dataclasses.replace(
        flow_diff,
        old_ref=old_ref,
        new_ref=new_ref or "(HEAD)",
        payload=canonicalize(kwargs),
    )

    # Output routing for --diff mirrors the single-flow path: --json overrides
    # all (structured artifact); --plain forces the text renderer (and is the
    # default when there's no TTY — CI/pipe/redirect — so the diff never crashes
    # or hangs waiting for a terminal); on a TTY with textual installed, launch
    # the interactive diff TUI (spec §7). The language is passed to the TUI for
    # mode transparency (the FlowDiff itself carries no language/adapter).
    if args.json:
        from .flow_render import to_diff_json
        print(to_diff_json(flow_diff))
    elif args.plain or not (sys.stdout.isatty() and _diff_tui_available()):
        print(render_diff(flow_diff))
    else:
        from .flow_diff_tui import run_diff_tui
        return run_diff_tui(flow_diff, language=lang)

    # 1 = change(s) surfaced for review (NOT a correctness verdict); 0 = clean.
    return 1 if not flow_diff.is_empty() else 0


def _repo_subpath(repo: str) -> str:
    """Path of ``repo`` relative to its git toplevel ("" if it IS the toplevel).

    So a src-layout ``--repo <clone>/src`` maps onto ``<worktree>/src`` on the
    OLD side. Best-effort: "" on any git failure (degrade to worktree root).
    """
    import subprocess
    try:
        out = subprocess.run(
            ["git", "-C", repo, "rev-parse", "--show-toplevel"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        rel = os.path.relpath(os.path.abspath(repo), out)
        return "" if rel == "." else rel
    except (OSError, subprocess.SubprocessError):
        return ""


def _resolve_head(repo: str) -> str | None:
    """Best-effort: the current commit hash of the repo working tree."""
    import subprocess
    try:
        out = subprocess.run(
            ["git", "-C", repo, "rev-parse", "--short", "HEAD"],
            check=True, capture_output=True, text=True,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dreplay-flow",
        description=(
            "Mode A: run an entrypoint once and show the observed business-object flow. "
            "Interactive TUI by default on a terminal; plain text when piped/CI."
        ),
    )
    parser.add_argument("--entrypoint", required=True, help="dotted 'module.func' to run")
    parser.add_argument("--input", default=None, help="JSON kwargs, e.g. '{\"name\": \"x\"}'")
    parser.add_argument("--input-file", default=None, help="file with JSON kwargs ('-' = stdin)")
    parser.add_argument("--repo", default=".", help="repo root (resolved on sys.path so the entrypoint imports)")
    parser.add_argument("--mode", choices=["instant", "fuzz"], default="instant")
    parser.add_argument("--schema", default=None, help="JSON Schema for inputs (Mode B fuzz)")
    parser.add_argument("--variants", type=int, default=8, help="number of fuzzed inputs (Mode B)")
    parser.add_argument("--allow-egress", action="store_true",
                        help="fuzz mode only: run the N variants FOR REAL instead of under "
                             "the kernel egress wall (instant/--diff always run for real)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--expand", action="append", default=[], help="expand node label(s) (repeatable)")
    parser.add_argument("--expand-all", action="store_true", help="show every node + full detail")
    parser.add_argument("--json", action="store_true", help="emit the structured artifact (overrides TUI/plain)")
    parser.add_argument("--html", action="store_true",
                        help="emit a self-contained shareable HTML page of the observed flow "
                             "(single-flow mode; carries the run's observed stdout/stderr evidence)")
    parser.add_argument("--plain", "--no-tui", dest="plain", action="store_true",
                        help="force the plain text renderer (skip TUI even on a terminal)")
    parser.add_argument("--tui", action="store_true",
                        help="force the TUI even without a TTY (may crash in non-terminal contexts)")
    parser.add_argument("--recipe", choices=["off", "auto", "synth"], default="off",
                        help="make the repo runnable before observing it (Python only): "
                             "off = use the host interpreter (default); auto = resolve the "
                             "repo's declared deps and provision a venv (runs the repo's build "
                             "+ network — never on untrusted code); synth = also allow Repo2Run "
                             "Dockerfile synthesis (needs Docker + an LLM key)")
    parser.add_argument("--language", default="auto",
                        choices=["auto", "py", "js", "ts", "cpp", "java", "go", "csharp"],
                        help="target language (default: auto-detect from repo)")
    parser.add_argument("--diff", action="store_true",
                        help="Mode A diff: observe the flow on OLD (--old ref, checked out into "
                             "a worktree) vs NEW (current repo) and diff them (spec §9.3)")
    parser.add_argument("--old", default=None,
                        help="the OLD git ref to diff against (branch/tag/commit/HEAD~1). "
                             "Required with --diff.")

    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2

    module, _, func = args.entrypoint.rpartition(".")
    if not module and ":" not in args.entrypoint:
        print("error: --entrypoint must be 'module.func' (or 'file:function' for C++)", file=sys.stderr)
        return 2

    kwargs = _load_input(args)
    repo = os.path.abspath(args.repo)

    # Language detection + adapter dispatch
    lang = args.language
    if lang == "auto":
        lang = _auto_detect_language(repo)

    # ---- --mode fuzz (Mode B, spec §2/§8.6): N variants, walled by default ----
    if args.mode == "fuzz":
        return _run_fuzz(args, lang, repo)

    print(
        f"dreplay-flow [{lang}]: running the entrypoint FOR REAL to observe behavior. "
        "Never use on untrusted code.",
        file=sys.stderr,
    )

    # Recipe layer (Python only): make the repo runnable before observing it.
    interpreter = _provision_recipe(args, lang, repo)

    # ---- --diff mode (spec §9.3): observe OLD (in a worktree) vs NEW (repo) ----
    if args.diff:
        return _run_diff(args, lang, kwargs, repo)

    # Mode A: dispatch to the right adapter based on language
    flow = _trace(lang, args.entrypoint, kwargs, repo, interpreter=interpreter)

    # Output routing: --json overrides all. Then: --plain forces text; --tui forces
    # TUI (even without TTY); DEFAULT = TUI if stdout.isatty() + textual installed,
    # else plain text. Never crashes/hangs waiting for a terminal.
    if args.json:
        print(to_json(flow))
    elif args.html:
        print(to_html(flow))
    elif args.plain:
        print(render_flow(flow, expand=tuple(args.expand), expand_all=args.expand_all))
    elif args.tui:
        from .flow_tui import run_tui
        return run_tui(flow)
    elif sys.stdout.isatty() and _tui_available():
        from .flow_tui import run_tui
        return run_tui(flow)
    else:
        # No TTY (CI, pipe, redirect, or textual not installed) → plain text.
        print(render_flow(flow, expand=tuple(args.expand), expand_all=args.expand_all))

    # 1 = the run raised or could not be observed (both printed above) — per the
    # documented contract; 0 = flow observed clean.
    return 1 if any(n.label in ("instrumentation-error", "thrown-error")
                    for n in flow.nodes) else 0


def _load_input(args) -> dict:
    raw = None
    if args.input_file:
        if args.input_file == "-":
            raw = sys.stdin.read()
        else:
            with open(args.input_file, encoding="utf-8") as fh:
                raw = fh.read()
    elif args.input:
        raw = args.input
    if raw is None:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"error: --input is not valid JSON: {exc}", file=sys.stderr)
        raise SystemExit(2)
    if not isinstance(data, dict):
        print("error: --input must be a JSON object of kwargs", file=sys.stderr)
        raise SystemExit(2)
    return data


def _run_fuzz(args, lang: str, repo: str) -> int:
    """--mode fuzz (Mode B, spec §2/§8.6): N seed-pinned schema variants.

    Walled by default: the pass multiplies real executions ×N, so it runs under
    kernel egress containment (network denied; filesystem/local side-effects and
    the real environment stay real) and REFUSES on hosts with no kernel wall.
    ``--allow-egress`` is the explicit opt-in to run the variants for real.

    Python entrypoints only for now — the per-language flow adapters run instant
    mode only (an honest limit, not a silent fallback).

    Exit codes: 0 = fuzz ran, nothing varied; 1 = varied operand(s) and/or
    unobserved variant(s) surfaced for review (NOT a verdict); 2 = usage error
    or refusal.
    """
    if lang not in ("py", "python"):
        print(
            f"error: --mode fuzz currently supports Python entrypoints only "
            f"(detected language: {lang}); the {lang} adapter runs instant mode only",
            file=sys.stderr,
        )
        return 2
    if not args.schema:
        print(
            "error: --mode fuzz requires --schema (a .json JSON Schema, or a .jsonl "
            "of example inputs to infer one from)",
            file=sys.stderr,
        )
        return 2
    if args.input or args.input_file:
        print(
            "error: --mode fuzz generates its inputs from --schema; drop --input/"
            "--input-file (to fuzz around real examples, supply them as a .jsonl schema)",
            file=sys.stderr,
        )
        return 2

    from . import schema as schema_mod
    try:
        schema = schema_mod.load(args.schema)
    except (OSError, ValueError) as exc:  # JSONDecodeError is a ValueError
        print(f"error: could not load schema from {args.schema!r}: {exc}", file=sys.stderr)
        return 2

    from .flow_fuzz import FuzzRefusal, fuzz_flow, render_fuzz, to_fuzz_json

    egress = "full" if args.allow_egress else "walled"
    if args.allow_egress:
        print(
            f"WARNING: --allow-egress — running {args.variants} fuzzed variants FOR "
            "REAL (real network + real environment); side-effects multiply ×variants. "
            "Never use on untrusted code or with production credentials in scope.",
            file=sys.stderr,
        )
    else:
        from . import containment
        level = containment.detect().level
        if level in ("seccomp", "kernel_netns"):
            print(
                f"dreplay-flow [py] fuzz: {args.variants} variants under kernel egress "
                f"containment ({level}) — network denied; filesystem/local side-effects "
                "still real. Never use on untrusted code.",
                file=sys.stderr,
            )
        # no kernel wall: stay silent here — fuzz_flow refuses below with the
        # full explanation (printing a wall we don't have would be a lie).

    module, _, func = args.entrypoint.rpartition(".")
    try:
        report = fuzz_flow(
            spec=ImplSpec(module=module, func=func), schema=schema,
            variant_count=args.variants, seed=args.seed,
            python_path=[repo], egress=egress,
        )
    except FuzzRefusal as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2

    print(to_fuzz_json(report) if args.json else render_fuzz(report))
    # 1 = something surfaced for review (varied operands / observed raises /
    # unobserved variants); 0 = observed and stable. Neither is a correctness
    # verdict. Raises MUST count: an all-raising pass exiting 0 "stable" was the
    # inverted-contract defect.
    return 1 if (report.varied or report.raises or report.errors) else 0


if __name__ == "__main__":
    raise SystemExit(main())
