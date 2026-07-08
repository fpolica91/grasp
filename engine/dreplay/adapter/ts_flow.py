"""TypeScript / NestJS FLOW-mode adapter (spec §2b, §8.8 — extended to TS).

The FLOW instrument observes what code does to business objects and emits an
honest :class:`~dreplay.flow.Flow`. The Node.js adapter
(:mod:`dreplay.adapter.node_flow`) already does this for JavaScript via AST-rewrite
tracing (:mod:`dreplay.js_trace`). TypeScript adds a type system (annotations,
generics, interfaces, decorators) that the esprima-based JS tracer cannot parse.

This adapter is the TS-specific orchestration layer. It does NOT re-implement the
tracer or the reduction — it reuses the proven JS machinery and adds the three
things TypeScript needs:

1. **Type stripping** (the tracer mechanism, :mod:`dreplay.ts_strip`) — turn the
   ``.ts`` source into plain JS that ``js_trace.rewrite`` can consume, then run it
   through :func:`dreplay.adapter.node_flow.node_flow` for real interior nodes.
   Authoritative path: the ``typescript`` npm module's ``transpileModule``. Fallback:
   a conservative regex stripper for simple-typed sources. Anything neither can
   handle falls back to the observed endpoints-only Flow — never a faked trace.

2. **NestJS decorators + DI** — NestJS wraps methods in a dependency-injection
   container; tracing the container would observe NestJS plumbing, not the business
   method. The authoritative ``transpileModule`` (with ``experimentalDecorators``)
   lowers decorator applications to ordinary JS while leaving the decorated METHOD
   as a callable function — so the JS tracer observes the real method call. For the
   regex fallback (which cannot lower decorators), decorator-bearing sources are
   refused and degrade to endpoints-only. When the source is a NestJS controller/
   service class, call ``ts_flow`` with ``method=`` pointing at the method body and
   ``classmethod=True`` so the adapter extracts just that method before stripping.

3. **Vocabulary** (:func:`derive_ts_vocabulary`) — read TS ``interface``/``type``
   declarations from the ORIGINAL ``.ts`` source. Their field names ARE the domain
   vocabulary; feeding them to the classifier puts it in ``vocab`` mode
   (schema-derived precision) instead of the 23-name conservative fallback.

Source maps: when the target is compiled TS (``.js`` + ``.js.map`` alongside),
:func:`derive_ts_vocabulary` reads field names from the original ``.ts`` (the map's
``sources``), so traced nodes — whose labels come from the lowered JS — bind
operands against the TS-declared vocabulary.

HONESTY RULE (docs/what-this-is.md §1, principle #7 — do not fake the plumbing):
the adapter never synthesizes a node the tracer did not observe. If type-stripping
fails, the AST-rewrite can't parse the result, or the node worker fails, the Flow
degrades to the honest endpoints-only view (input + return/error + outbound) with
the labelled ``interior-unobservable`` note carried by ``node_flow``.
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from dataclasses import replace
from typing import Any

from .. import ts_strip
from ..flow import Flow
from .node_flow import node_flow

# --------------------------------------------------------------------------- #
# Tracer entrypoint
# --------------------------------------------------------------------------- #
def ts_flow(
    *,
    source_path: str,
    func: str,
    kwargs: dict[str, Any] | None = None,
    timeout_s: float = 30.0,
    search_paths: list[str] | None = None,
    classmethod: bool = False,
    vocab_fields: set[str] | None = None,
) -> Flow:
    """Run ONE TypeScript function/method and capture its interior as an observed
    :class:`Flow`.

    Parameters mirror the engine's adapter contract, narrowed for FLOW mode:

    * ``source_path`` — absolute path to a ``.ts``/``.tsx`` source whose top level
      exports ``func`` (CommonJS ``module.exports = {func}`` after lowering), OR a
      class with a method when ``classmethod=True``.
    * ``func`` — the exported function name to call (or the method name when
      ``classmethod=True``).
    * ``kwargs`` — values passed positionally in insertion order (the common JS
      positional case shared with the Node adapter).
    * ``timeout_s`` — node subprocess timeout.
    * ``search_paths`` — dirs whose ``node_modules`` may hold the ``typescript``
      npm module (the target's repo root). When absent, only the global module is
      probed; the regex fallback handles simple-typed sources regardless.
    * ``classmethod`` — when True, ``func`` is a METHOD on the first class in the
      source. The adapter extracts an instance of the class + the method into a
      CommonJS export before stripping, so the JS tracer observes the real method
      body (not the NestJS DI container).
    * ``vocab_fields`` — business field names derived from the target's TS
      ``interface``/``type`` declarations (see :func:`derive_ts_vocabulary`).
      When provided, the returned Flow's ``classifier_mode`` is ``vocab`` and
      ``vocab_size`` reflects the count.

    Returns an observed :class:`Flow`. The default (business-meaningful) view
    includes the input node, one node per traced interior call (with bound
    operands), the return node (or a thrown-error node), and any external_call
    node. When type-stripping or the AST-rewrite cannot handle the source, the Flow
    degrades to endpoints-only with the labelled honest gap note.

    If ``node`` is not on PATH, returns an ``instrumentation-error`` Flow (honest —
    never a fake clean run).
    """
    kwargs = dict(kwargs or {})
    entrypoint = f"{os.path.basename(source_path)}::{func}"

    if shutil.which("node") is None:
        return _error_flow(entrypoint, kwargs, "node executable not found on PATH")

    try:
        source = open(source_path, encoding="utf-8").read()
    except OSError as exc:
        return _error_flow(entrypoint, kwargs, f"could not read source: {exc}")

    # NestJS/class-method handling: extract the method into a callable export so
    # the JS tracer observes the method body, not the DI container.
    if classmethod:
        source = _extract_method_as_export(source, func)

    # Type-strip → JS. Authoritative (typescript module) first; regex fallback for
    # simple-typed sources; both refuse on what they can't handle.
    search = list(search_paths or [os.path.dirname(os.path.abspath(source_path))])
    js, strategy, ok = ts_strip.strip_types_best_effort(
        source, file_name=os.path.basename(source_path), search_paths=search,
    )
    if not ok:
        # Neither path produced trustworthy JS. Degrade to endpoints-only by
        # letting node_flow trace the ORIGINAL source — esprima will reject TS
        # syntax and node_flow will fall back to its honest endpoints-only Flow.
        strategy = "none"

    # Write the (type-stripped) JS to a temp CommonJS module and run it through the
    # proven JS traced path. node_flow tries AST-rewrite interior tracing first and
    # falls back to endpoints-only on any failure — never fakes.
    js_to_run = js if ok else source
    with tempfile.NamedTemporaryFile(
        "w", suffix=".js", delete=False, encoding="utf-8"
    ) as tf:
        tf.write(js_to_run)
        js_path = tf.name

    try:
        flow = node_flow(
            module_path=js_path, func=func, kwargs=kwargs, timeout_s=timeout_s,
        )
    finally:
        try:
            os.unlink(js_path)
        except OSError:
            pass

    # Enrich the Flow with the TS-derived vocabulary + classifier mode + the
    # strip-strategy transparency. The vocab widens which observed fields bind as
    # operands (vocab mode = schema-derived precision). The Flow is frozen, so we
    # rebuild it with the classifier fields set.
    fields = set(vocab_fields or ())
    # Re-derive vocab from the target source if the caller didn't supply it, so the
    # status line is always honest about the classifier mode actually in effect.
    if not fields:
        fields = derive_ts_vocabulary([source_path])

    enriched = _with_classifier(flow, fields, strategy)
    _emit_status_line(entrypoint, fields, strategy)
    return enriched


# --------------------------------------------------------------------------- #
# NestJS / class-method extraction
# --------------------------------------------------------------------------- #
def _extract_method_as_export(source: str, method: str) -> str:
    """Extract a class method into a standalone CommonJS export so the JS tracer
    observes the method BODY, not the NestJS DI container.

    Strategy: replace the class's method body is unnecessary — instead we APPEND a
    tiny bootstrap that instantiates the first class and re-exports the bound
    method. The decorator applications (already lowered by transpileModule, or
    left in place for the regex path) run at class-definition time as real JS; the
    bootstrap then calls the resulting method directly. This observes the actual
    method call with its real arguments.

    For the regex fallback (decorators not lowered), decorator-bearing classes are
    refused upstream — so this bootstrap only runs on decorator-free or
    compiler-lowered sources.

    Returns the source with an appended CommonJS export of ``method``.
    """
    cls_name = _first_class_name(source)
    if not cls_name:
        return source  # no class found — leave as-is; caller's func resolves it
    bootstrap = (
        f"\n// dreplay NestJS/class-method bootstrap: instantiate + re-export the\n"
        f"// bound method so the tracer observes the method body, not the DI container.\n"
        f"try {{\n"
        f"  const __dreplay_instance = new {cls_name}();\n"
        f"  if (typeof __dreplay_instance.{method} === 'function') {{\n"
        f"    module.exports = module.exports || {{}};\n"
        f"    module.exports.{method} = (...a) => __dreplay_instance.{method}(...a);\n"
        f"  }}\n"
        f"}} catch (e) {{ /* DI ctor needs providers — fall through to direct export */ }}\n"
    )
    return source + bootstrap


def _first_class_name(source: str) -> str | None:
    """The first `class Name` declaration's name, or None."""
    m = re.search(r"\bclass\s+([A-Za-z_$][\w$]*)", source)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- #
# Vocabulary deriver — TS interface/type field names from source
# --------------------------------------------------------------------------- #
# Match `interface Name {` or `type Name = {` openers (also `export`/`declare`).
_INTERFACE_OPEN = re.compile(
    r"(?m)^\s*(?:export\s+|declare\s+|abstract\s+)*interface\s+([A-Za-z_$][\w$]*)\b"
)
_TYPE_ALIAS_OPEN = re.compile(
    r"(?m)^\s*(?:export\s+|declare\s+)*type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=\s*\{"
)
# A field inside an interface/type body: `[readonly] name[?]: Type`. NOT anchored to
# line start (fields may share a line: `id: string; amount: number;`). We require a
# preceding boundary (`;`, `{`, newline, or start) so we don't match inside a type
# annotation (e.g. the `string` in `a: string` — there `string` has no following `:`).
_TS_FIELD_RE = re.compile(
    r"(?:^|[;{}\n,])\s*"            # field separator / body start
    r"(?:readonly\s+)?"             # optional readonly
    r"([A-Za-z_$][\w$]*)\s*\??\s*:"  # field NAME (captured), optional `?`, then `:`
)

# TS plumbing field names that are framework/runtime, not business. Mirrors the
# shared _PLUMBING_FIELDS intent but kept TS-specific (NestJS decorators metadata,
# ORM entities, HTTP request/response).
_PLUMBING_TS = {
    "constructor", "toString", "valueOf", "toJSON", "toPrimitive",
    "request", "response", "headers", "statusCode", "method", "url", "host",
    "port", "scheme", "config", "opts", "options", "env", "ctx", "context",
    "logger", "log", "tracer", "span", "metadata", "meta", "params", "query",
    "session", "cookie", "cookies", "connection", "pool", "cache", "buffer",
}


def derive_ts_vocabulary(source_paths: list[str]) -> set[str]:
    """Read TypeScript ``interface``/``type`` field declarations from source →
    field names (the domain vocabulary).

    Regex-based (no TS compiler AST required for vocab — we only need field NAMES,
    which the surface syntax exposes unambiguously). Walks the source tracking
    brace depth; collects field names only inside an ``interface { ... }`` or
    ``type X = { ... }`` body. Method signatures (lines with ``(...)``) and index
    signatures (``[key: string]``) are skipped.

    Best-effort: a source that won't parse cleanly just yields fewer fields; never
    raises. When no fields are found the classifier degrades to non_vocab (the
    23-name dominant set) — see ``instrument._bind_field``.
    """
    fields: set[str] = set()
    for sp in source_paths:
        if not sp or not os.path.isfile(sp):
            continue
        try:
            text = open(sp, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        fields |= _ts_fields_from_text(text)
    return fields


def _ts_fields_from_text(text: str) -> set[str]:
    """Collect field names from interface/type bodies.

    Finds each ``interface Name { ... }`` / ``type Name = { ... }`` body by
    brace-matching (so multi-field single-line declarations work), then extracts
    field names with ``_TS_FIELD_RE`` over the body text. Method signatures
    (``name(...)``) and index signatures (``[key: ...]``) are skipped per-match.
    """
    fields: set[str] = set()
    for body in _iter_vocab_bodies(text):
        for m in _TS_FIELD_RE.finditer(body):
            # Skip if this match is actually a method signature: a `(` precedes
            # the colon on the same logical segment.
            seg = body[m.start():].split(":", 1)[0]
            if "(" in seg or "[" in seg:
                continue
            name = m.group(1)
            if name not in _PLUMBING_TS:
                fields.add(name)
    return {f for f in fields if f and not f.startswith("_")}


def _iter_vocab_bodies(text: str):
    """Yield the body text (between the matching braces) of each
    ``interface Name {...}`` and ``type Name = {...}`` declaration."""
    for opener in (_INTERFACE_OPEN, _TYPE_ALIAS_OPEN):
        for m in opener.finditer(text):
            # Find the opening brace. _TYPE_ALIAS_OPEN consumes its `{`; _INTERFACE_OPEN
            # does not (the `{` follows the name). Search from the match start so both
            # cases resolve to the first `{` at/after the declaration keyword.
            brace = text.find("{", m.start())
            if brace < 0:
                continue
            depth, i = 0, brace
            while i < len(text):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        yield text[brace + 1 : i]
                        break
                i += 1


# --------------------------------------------------------------------------- #
# Status line (spec §2d) — adapter + classifier mode + vocab count + strategy
# --------------------------------------------------------------------------- #
def status_line(source_path: str, vocab_fields: set[str], strategy: str = "none") -> str:
    """The mode-transparency status line (the reviewer's [Certain] prerequisite):
    adapter + classifier mode + vocab count + the type-strip strategy actually used.
    """
    mode = "vocab" if vocab_fields else "non_vocab"
    strat = {
        "typescript": "tsc-transpile", "regex": "regex-strip", "none": "endpoints-only",
    }.get(strategy, strategy)
    return (
        f"[ts-flow] adapter=typescript classifier_mode={mode} "
        f"vocab_count={len(vocab_fields)} strip_strategy={strat}"
    )


def _emit_status_line(entrypoint: str, fields: set[str], strategy: str) -> None:
    """Print the status line to stderr (never pollutes a captured stdout payload)."""
    sys.stderr.write(status_line(entrypoint, fields, strategy) + "\n")


# --------------------------------------------------------------------------- #
# Flow enrichment — set classifier fields on the frozen Flow
# --------------------------------------------------------------------------- #
def _with_classifier(flow: Flow, fields: set[str], strategy: str) -> Flow:
    """Return a copy of ``flow`` with the TS-derived classifier fields set.

    The Flow is a frozen dataclass; we rebuild it. ``classifier_mode``/``vocab_size``
    mirror what ``instrument._reduce`` sets for the Python adapter, so the renderer's
    mode-transparency display is consistent across languages. ``fallback_reason``
    records the strip strategy so the reviewer can tell a tsc-transpiled trace from
    a regex-stripped or endpoints-only one.
    """
    return replace(
        flow,
        classifier_mode="vocab" if fields else flow.classifier_mode,
        vocab_size=len(fields) if fields else flow.vocab_size,
        fallback_reason=(
            flow.fallback_reason
            or ({"typescript": None, "regex": "type-strip via regex (no typescript module)",
                 "none": "type-strip failed — endpoints-only"}[strategy])
        ),
    )


# --------------------------------------------------------------------------- #
# Error flow (worker-level failure — no node ran)
# --------------------------------------------------------------------------- #
def _error_flow(entrypoint: str, kwargs: dict, message: str) -> Flow:
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
                open_question=(
                    f"TypeScript FLOW adapter could not observe this run: {message} "
                    f"— supply a runnable entrypoint?"
                ),
            ),
        ),
        containment_level="none",
    )
