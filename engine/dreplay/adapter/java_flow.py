"""Java/JVM FLOW-mode adapter (spec §8.8 — language seam extends to the JVM).

The FLOW instrument observes what code does to business objects and emits an honest
:class:`~dreplay.flow.Flow`. This adapter proves the core/adapter seam extends to the
JVM for FLOW mode: it runs ONE Java entrypoint on a JSON input and captures the
**interior** call/return state the JVM tracer observed — real interior nodes, not
synthesized.

TRACER MECHANISM: a ``-javaagent`` JAR (``java_agent/``) built from this same repo.
At JVM load it installs a ``ClassFileTransformer`` that uses ASM bytecode
instrumentation (an ``AdviceAdapter``) to inject ``FlowRecorder.enter`` on method
entry (snapshotting the arguments) and ``FlowRecorder.exit`` on method exit
(snapshotting the return value / thrown throwable). A JVM shutdown hook emits the
Flow JSON protocol to stdout, which this adapter parses. Every value is observed
(principle #1); nothing is inferred.

This is the FIRST adapter with TRUE interior nodes on a non-Python runtime: the
bytecode tracer sees every call/return in the target package, so unlike the JS
endpoints-only adapter, the JVM adapter reduces real interior :class:`Node`\\s.
The gap surfaced honestly (an ``other`` note, ``business_meaningful=False``) is only
for the one thing bytecode cannot see — the *names* of method parameters (the JVM
doesn't carry them without ``-parameters``), so args bind positionally as
``arg0/arg1/...``.

Adapter contract (see ``adapter/base.py``):
  * spawns the JVM as a subprocess with ``-javaagent`` + ``-cp``;
  * the tracer emits the Flow JSON;
  * this adapter parses it and calls ``dreplay.instrument._reduce`` — the SAME
    reducer the Python instrument uses — so a Java flow and a Python flow are
    reduced identically and diff cleanly.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import replace
from typing import Any

from ..flow import Flow
from ..instrument import _reduce
from ..types import ImplSpec
from ..vocabulary import VocabularyResult, derive_vocabulary_detailed
from .java_agent.build_agent import build_agent, have_jdk

_AGENT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "java_agent")


def _java_runtime() -> str | None:
    """The ``java`` executable, or None. (``java`` and ``javac`` are separate —
    the JRE can run .class files without the JDK.)"""
    return shutil.which("java")


def java_available() -> bool:
    """True if BOTH a JVM (to run) and a JDK (to build the agent) are present."""
    return _java_runtime() is not None and have_jdk()


def _compile_sources(src_dir: str, out_dir: str) -> tuple[bool, str]:
    """Compile every .java under src_dir into out_dir. Returns (ok, message)."""
    sources: list[str] = []
    for root, _dirs, files in os.walk(src_dir):
        for f in files:
            if f.endswith(".java"):
                sources.append(os.path.join(root, f))
    if not sources:
        return False, f"no .java sources found under {src_dir}"
    os.makedirs(out_dir, exist_ok=True)
    proc = subprocess.run(
        ["javac", "-nowarn", "-d", out_dir, *sources],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return False, f"javac failed:\n{proc.stderr}"
    return True, ""


def java_flow(
    *,
    src_dir: str,
    main_class: str,
    kwargs: dict[str, Any] | None = None,
    target_pkg: str = "",
    func: str | None = None,
    timeout_s: float = 60.0,
    python_path: list[str] | None = None,
) -> Flow:
    """Run ONE Java main class and capture its traced call/return as a Flow.

    Parameters mirror the engine's adapter contract, narrowed for FLOW mode:

    * ``src_dir`` — directory containing the target's ``.java`` sources (compiled
      into a temp dir; the sources are the source of truth, never stale .class).
    * ``main_class`` — the fully-qualified ``main`` class to run
      (e.g. ``org.example.Hello``). Its ``main(String[])`` is the JVM entrypoint.
    * ``kwargs`` — passed to ``main`` as a SINGLE positional element: a JSON string
      of the values, in insertion order. The target's ``main`` decodes it. This is
      the documented differ-adapter mapping for a ``main``-entrypoint language.
    * ``target_pkg`` — the package prefix to instrument (e.g. ``org.example``).
      Classes outside it (JDK, other libs) are never traced. Empty = instrument
      everything that isn't the JDK/agent.
    * ``func`` — the BUSINESS entrypoint method (default: ``main``). Java's ``main``
      is ``void`` and is only the JVM harness; the business output is produced by an
      interior call. When ``func`` names that interior method, the reducer designates
      it as the entrypoint: its observed return becomes the Flow's return node, and
      its calls become the interior nodes. If omitted, ``main`` is the entrypoint
      (its return is void → the return node carries no operands).
    * ``python_path`` — for vocabulary derivation (the target's own model sources).

    Returns a :class:`Flow` reduced by the SAME ``_reduce`` the Python instrument
    uses, so interior call/return nodes, business operands, and provenance are
    identical in shape to a Python flow.
    """
    entry_func = func or "main"
    entrypoint = f"{main_class}.{entry_func}"
    kwargs = dict(kwargs or {})

    # --- Honest gate: if we can't build the agent or run the JVM, say so plainly.
    java_exe = _java_runtime()
    if java_exe is None:
        return _error_flow(entrypoint, kwargs, "java executable (JRE) not found on PATH")
    if not have_jdk():
        return _error_flow(entrypoint, kwargs,
                           "javac not on PATH — cannot build the -javaagent JAR")

    try:
        agent_jar = build_agent()
    except Exception as exc:  # noqa: BLE001
        return _error_flow(entrypoint, kwargs, f"could not build -javaagent JAR: {exc}")

    # --- Compile the target's sources fresh into a temp classes dir.
    classes_dir = os.path.join(_AGENT_DIR, "build", "target-classes")
    # Wipe so stale .class never survives a source rename.
    if os.path.isdir(classes_dir):
        shutil.rmtree(classes_dir)
    ok, msg = _compile_sources(src_dir, classes_dir)
    if not ok:
        return _error_flow(entrypoint, kwargs, msg)

    # --- Run: java -javaagent:agent.jar=targetPkg=... -cp classes Main [jsonArgs]
    # The single positional arg is the JSON of the kwargs values (in order) so the
    # target main can decode the business object — the same shape the JS adapter
    # uses (positional args in insertion order).
    arg_json = json.dumps(list(kwargs.values())) if kwargs else ""
    agent_arg = f"=targetPkg={target_pkg}" if target_pkg else "="
    cmd = [
        java_exe,
        f"-javaagent:{agent_jar}{agent_arg}",
        "-cp", classes_dir,
        main_class,
    ]
    if arg_json:
        cmd.append(arg_json)

    env = dict(os.environ)
    try:
        proc = subprocess.run(
            cmd, env=env, capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return _error_flow(entrypoint, kwargs, f"java worker timed out after {timeout_s}s")
    except FileNotFoundError:
        return _error_flow(entrypoint, kwargs, "java executable not found on PATH")

    # The agent writes the Flow JSON to STDOUT (its own diagnostics to stderr).
    out = proc.stdout
    # The JSON is the LAST non-empty line — defensive against any target stdout.
    json_line = ""
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("{"):
            json_line = s
    try:
        data = json.loads(json_line) if json_line else None
    except json.JSONDecodeError:
        data = None
    if data is None:
        detail = (out or proc.stderr or f"exit {proc.returncode}")[:500]
        return _error_flow(entrypoint, kwargs,
                           f"java agent produced no Flow JSON: {detail}")

    # --- Honest failure detection: if the JVM exited non-zero with NO observed
    # events, main never ran (class not found, NoClassDefFound, verify error, ...).
    # The shutdown hook still flushed an empty event list, but that is NOT a clean
    # "no divergence" — it is a run that didn't happen. Surface it honestly rather
    # than emit a false clean flow (principle #5).
    events = data.get("events", []) if isinstance(data, dict) else []
    if proc.returncode != 0 and not events:
        detail = (proc.stderr or out or f"exit {proc.returncode}")[:500]
        return _error_flow(entrypoint, kwargs,
                           f"java exited {proc.returncode} with no observed events: {detail}")

    # --- Lift the business entrypoint's observed return into the top-level "return"
    # so the reducer's return node binds the BUSINESS output. Java's main is void;
    # when ``func`` names an interior method, its return IS the observable result.
    if func and isinstance(data, dict):
        lifted = None
        for ev in reversed(events):
            if ev.get("func") == func and "return" in ev:
                lifted = ev["return"]
                break
        data["return"] = lifted

    # --- Derive vocabulary from the target's own model sources (POJO/record fields).
    vocab_paths = python_path or [src_dir]
    try:
        from . import java_vocab
        vocab_result = java_vocab.derive_java_vocabulary(vocab_paths)
    except Exception:  # noqa: BLE001
        vocab_result = VocabularyResult(set(), 0, 0, 0)

    # --- Reduce with the SAME reducer the Python instrument uses.
    spec = ImplSpec(module=main_class, func=entry_func)
    # The agent's events are the entrypoint's interior calls; _reduce skips the frame
    # named spec.func (like it skips spec.func for the Python trace) so the
    # entrypoint's own frame doesn't double up as an interior node.
    flow = _reduce(spec, kwargs, "instant", seed=None, data=data,
                   containment_level="none", vocab_result=vocab_result)

    # Status line (spec deliverable d): adapter + classifier mode + vocab count.
    sys.stderr.write(
        f"[dreplay] adapter=java-jvm classifier={flow.classifier_mode} "
        f"vocab={flow.vocab_size} events={len(data.get('events', []))}\n"
    )
    return flow


# --------------------------------------------------------------------------- #
# Honest error flow (no synthesis)
# --------------------------------------------------------------------------- #
def _error_flow(entrypoint: str, kwargs: dict, message: str) -> Flow:
    """Agent/compile/run-level failure. Honest: an instrumentation-error node,
    business-meaningful so the human sees it, with the kwargs as the observed input."""
    from ..flow import Node, Operand

    input_ops = tuple(
        Operand(name=k, value=v, provenance="observed") for k, v in kwargs.items()
    )
    return Flow(
        entrypoint=entrypoint, mode="instant",
        nodes=(
            Node(kind="input", label=entrypoint, operands=input_ops,
                 business_meaningful=True),
            Node(
                kind="other", label="instrumentation-error", provenance="unknown",
                operands=(Operand(name="error", value=message, provenance="unknown"),),
                business_meaningful=True,
                open_question=f"java FLOW adapter could not observe this run: {message} "
                              f"— supply a runnable entrypoint?",
            ),
        ),
        containment_level="none",
    )
