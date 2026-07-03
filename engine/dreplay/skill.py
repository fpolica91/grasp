"""grasp skills — the agent-callable seam. Skills orchestrate, code observes.

The agent decides WHEN and WHAT to trace and calls these; the code runs the real
tracer. Each returns the graph data contract (:mod:`dreplay.flow_graph`) as a plain
JSON-serializable dict — observed facts + neutral questions, never a verdict. This
is what replaces the human CLI's arg/TUI/exit-code ceremony: the agent reads JSON,
the surface renders it, the human adjudicates.

Three capabilities, mirroring the three behavioral primitives:
  * :func:`observe` — run the entrypoint once, return the observed dataflow graph.
  * :func:`diff`    — observe OLD vs NEW for the same input, return both graphs + the
                      behavioral delta (the "dataflow changed A→B — expected?" view).
  * :func:`fuzz`    — vary the input across a schema, return which operands varied
                      (the new stack trace: edge cases the author may not have hit).

Runs code FOR REAL (Mode A) — never on untrusted code. ``fuzz`` is walled by default.
"""
from __future__ import annotations

import dataclasses
import json
import os

from .flow_cli import (
    _auto_detect_language, _repo_subpath, _resolve_head, _trace,
)
from .flow_diff import align_and_diff
from .flow_graph import graph_diff_model, graph_model
from .types import ImplSpec
from . import worktree


def _lang(repo: str, language: str | None) -> str:
    return _auto_detect_language(repo) if language in (None, "auto") else language


def _recipe_interpreter(repo: str, recipe: str) -> str | None:
    """Resolve+provision a runnable env (Python only). None keeps the host interpreter.
    Degrades honestly on any provisioning failure — never a hidden guess."""
    if recipe == "off":
        return None
    from .recipe import provision, resolve_env
    try:
        env = provision(resolve_env(repo, allow_synth=(recipe == "synth")), repo)
    except Exception:  # noqa: BLE001 — honest fallback to host interpreter
        return None
    return env.interpreter_path


def _instrumentation_error(flow) -> str | None:
    """The config-level 'could not observe' message (distinct from an observed
    thrown-error, which IS a fact). None when the run was observed."""
    return next(
        (o.value for n in flow.nodes if n.label == "instrumentation-error"
         for o in n.operands if o.name == "error"),
        None,
    )


def observe(*, repo: str, entrypoint: str, input: dict | None = None,
            language: str = "auto", recipe: str = "off") -> dict:
    """Run ``entrypoint`` once for real and return the observed dataflow graph."""
    repo = os.path.abspath(repo)
    lang = _lang(repo, language)
    interp = _recipe_interpreter(repo, recipe) if lang in ("py", "python") else None
    flow = _trace(lang, entrypoint, input or {}, repo, interpreter=interp)
    err = _instrumentation_error(flow)
    raised = any(n.label == "thrown-error" for n in flow.nodes)
    return {
        "capability": "observe",
        "ok": True,                 # the skill ran
        "observed": err is None,    # a real execution was captured
        "raised": raised,           # the observed run raised (a FACT, not a failure)
        "language": lang,
        "error": err,               # config-level 'could not observe', if any
        "graph": graph_model(flow),
    }


def diff(*, repo: str, entrypoint: str, old_ref: str, input: dict | None = None,
         language: str = "auto") -> dict:
    """Observe OLD (a git ref, checked out into a worktree) vs NEW (the working tree)
    for the SAME input, and return both graphs + the behavioral delta.

    Refuses (``ok: False``) rather than surface phantom change if either side could
    not be observed — a diff against an un-run side is not behavior."""
    repo = os.path.abspath(repo)
    lang = _lang(repo, language)
    kwargs = input or {}
    rel = _repo_subpath(repo)
    new_ref = _resolve_head(repo)
    wt: str | None = None
    try:
        wt = worktree.add(repo, old_ref)
        old_repo = os.path.join(wt, rel) if rel else wt
        flow_old = _trace(lang, entrypoint, kwargs, old_repo)
        flow_new = _trace(lang, entrypoint, kwargs, repo)
    finally:
        if wt is not None:
            worktree.remove(wt, repo_path=repo)

    for side, fl in (("old", flow_old), ("new", flow_new)):
        err = _instrumentation_error(fl)
        if err is not None:
            return {
                "capability": "diff", "ok": False, "diff": None,
                "error": (f"the {side} side could not be observed ({err}); a flow-diff "
                          "against an un-run side would be phantom change, not behavior"),
            }

    from .canonical import canonicalize
    from .flow_render import _diff_to_dict
    fd = align_and_diff(flow_old, flow_new)
    fd = dataclasses.replace(fd, old_ref=old_ref, new_ref=new_ref or "(HEAD)",
                             payload=canonicalize(kwargs))
    return {
        "capability": "diff", "ok": True,
        "changed": not fd.is_empty(),        # change surfaced for review — NOT a verdict
        "old_ref": old_ref, "new_ref": new_ref,
        "language": lang,
        "delta": _diff_to_dict(fd),
        # The A→B change view — the headline surface renders this directly.
        "graph_diff": graph_diff_model(fd),
        # Both observed graphs also travel (comprehension of each side on demand).
        "old_graph": graph_model(flow_old),
        "new_graph": graph_model(flow_new),
    }


def fuzz(*, repo: str, entrypoint: str, schema: str, variants: int = 8, seed: int = 0,
         allow_egress: bool = False) -> dict:
    """Vary the input across ``schema`` (a JSON Schema path) and return which operands
    varied across inputs — the edge cases the author may not have hit. Python only;
    walled by default (``allow_egress`` runs the variants for real)."""
    repo = os.path.abspath(repo)
    lang = _lang(repo, "auto")
    if lang not in ("py", "python"):
        return {"capability": "fuzz", "ok": False,
                "error": f"fuzz supports Python entrypoints only (detected {lang})"}
    from . import schema as schema_mod
    try:
        sch = schema_mod.load(schema)
    except (OSError, ValueError) as exc:
        return {"capability": "fuzz", "ok": False,
                "error": f"could not load schema from {schema!r}: {exc}"}

    from .flow_fuzz import FuzzRefusal, fuzz_flow, to_fuzz_json
    module, _, func = entrypoint.rpartition(".")
    try:
        report = fuzz_flow(
            spec=ImplSpec(module=module, func=func), schema=sch,
            variant_count=variants, seed=seed, python_path=[repo],
            egress=("full" if allow_egress else "walled"),
        )
    except FuzzRefusal as exc:
        return {"capability": "fuzz", "ok": False, "error": f"refused: {exc}"}
    return {
        "capability": "fuzz", "ok": True,
        "varied": bool(report.varied or report.raises or report.errors),
        "report": json.loads(to_fuzz_json(report)),
    }


# --------------------------------------------------------------------------- #
# Thin CLI so the agent can invoke a skill over Bash and read JSON on stdout.
# `python -m dreplay.skill observe --repo R --entrypoint E [--input '{...}']`
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(
        prog="grasp-skill",
        description="Agent-callable flow skills — emit the graph contract as JSON.",
    )
    sub = p.add_subparsers(dest="cap", required=True)
    for name in ("observe", "diff", "fuzz"):
        sp = sub.add_parser(name)
        sp.add_argument("--repo", default=".")
        sp.add_argument("--entrypoint", required=True)
        if name != "fuzz":
            sp.add_argument("--input", default=None, help="JSON kwargs")
            sp.add_argument("--language", default="auto")
        if name == "observe":
            sp.add_argument("--recipe", choices=["off", "auto", "synth"], default="off")
        if name == "diff":
            sp.add_argument("--old", required=True, help="OLD git ref to diff against")
        if name == "fuzz":
            sp.add_argument("--schema", required=True)
            sp.add_argument("--variants", type=int, default=8)
            sp.add_argument("--seed", type=int, default=0)
            sp.add_argument("--allow-egress", action="store_true")

    args = p.parse_args(argv)
    inp = json.loads(args.input) if getattr(args, "input", None) else None
    if args.cap == "observe":
        out = observe(repo=args.repo, entrypoint=args.entrypoint, input=inp,
                      language=args.language, recipe=args.recipe)
    elif args.cap == "diff":
        out = diff(repo=args.repo, entrypoint=args.entrypoint, old_ref=args.old,
                   input=inp, language=args.language)
    else:
        out = fuzz(repo=args.repo, entrypoint=args.entrypoint, schema=args.schema,
                   variants=args.variants, seed=args.seed, allow_egress=args.allow_egress)
    print(json.dumps(out, indent=2, sort_keys=True, default=repr))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
