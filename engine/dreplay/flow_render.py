"""Render an observed :class:`~dreplay.flow.Flow` — collapsed by default (spec §4).

The default view shows ONLY business-meaningful nodes (the adjudicable ones);
plumbing is collapsed into a muted count line, not deleted. Any node can be
expanded (``expand=``) to full detail; ``expand_all`` shows everything.

Plain text in v1 (works everywhere, no dep). The interactive Textual TUI (§11) is
a later layer on top of :func:`render_flow` / :func:`to_json`.

The renderer never adds information: it prints observed operands + the instrument's
open questions verbatim. It emits no verdicts.
"""
from __future__ import annotations

import html
import json

from .flow import Flow, Node
from .flow_diff import FlowDiff, NodeDiff, OperandDelta


def render_flow(flow: Flow, *, expand: tuple[str, ...] = (), expand_all: bool = False) -> str:
    lines: list[str] = []
    lines.append(
        f"flow: {flow.entrypoint}   mode: {flow.mode}   containment: {flow.containment_level}"
    )
    # MODE TRANSPARENCY (the reviewer's [Certain] prerequisite): the reviewer MUST know
    # whether they're seeing the schema-derived classifier or the 23-name fallback.
    # Without this, a vocab=0 silent degrade looks identical to a clean run.
    if flow.classifier_mode == "vocab":
        lines.append(f"classifier: VOCAB mode, {flow.vocab_size} fields derived from models")
    else:
        reason = flow.fallback_reason or "no models found"
        lines.append(f"classifier: NON-VOCAB fallback — {reason}")
    if not flow.default_nodes():
        lines.append("  (no business-meaningful nodes observed)")
    lines.append("")

    collapsed_run = 0
    for node in flow.nodes:
        show = node.business_meaningful or expand_all or node.label in expand
        if not show:
            collapsed_run += 1
            continue
        if collapsed_run:
            lines.append(f"  ⋯ {collapsed_run} plumbing step(s) collapsed")
            collapsed_run = 0
        lines.append(_render_node(node, full=expand_all or node.label in expand))
    if collapsed_run:
        lines.append(f"  ⋯ {collapsed_run} plumbing step(s) collapsed")

    questions: list[str] = []
    seen: set[str] = set()
    for n in flow.nodes:
        if n.open_question and n.open_question not in seen:
            seen.add(n.open_question)
            questions.append(n.open_question)
    if questions:
        lines.append("")
        lines.append("open questions (you adjudicate — no verdicts here):")
        for q in questions:
            lines.append(f"  ? {q}")

    # Empty-state hint: only when the run genuinely observed nothing but
    # input→return — no business nodes beyond them AND no interior/plumbing nodes
    # at all. If interior steps were traced (just collapsed), the "executes no
    # interior business logic" claim would contradict the collapsed-steps line
    # the reader can expand — so we must not print it then.
    business = flow.default_nodes()
    has_error = any(n.label == "instrumentation-error" for n in flow.nodes)
    n_interior = len(flow.nodes) - len(business)  # collapsed plumbing + interior
    if len(business) <= 2 and n_interior == 0 and not questions and not has_error:
        lines.append("")
        lines.append(
            "ℹ️  This entrypoint produced only input → return — it binds data but executes no\n"
            "   interior business logic. Point at a handler, service method, or controller\n"
            "   (something that calls helpers, checks auth, writes, branches) to see a flow."
        )
    return "\n".join(lines)


def _render_node(node: Node, *, full: bool) -> str:
    marker = "▶" if node.business_meaningful else "·"
    head = f"  {marker} {node.kind:<14} {node.label}"
    if node.operands:
        ops = "  ".join(f"{o.name}={o.value!r}" for o in node.operands)
        head += f"   {ops}"
    parts = [head]
    if full:
        if node.business_objects:
            for bo in node.business_objects:
                flds = ", ".join(f"{k}={v.shape!r}" for k, v in bo.fields.items())
                parts.append(f"      {bo.name}{{{flds}}}")
        if node.raw_detail:
            parts.append(f"      detail: {node.raw_detail}")
    return "\n".join(parts)


def to_json(flow: Flow) -> str:
    """Structured artifact (spec §5) — the MR-attachable observed flow."""
    return json.dumps(_flow_to_dict(flow), indent=2, sort_keys=True)


def to_diff_json(flow_diff: FlowDiff) -> str:
    """Structured artifact for a :class:`FlowDiff` (the MR-attachable diff)."""
    return json.dumps(_diff_to_dict(flow_diff), indent=2, sort_keys=True)


def _diff_to_dict(d: FlowDiff) -> dict:
    payload = getattr(d.payload, "shape", d.payload)
    return {
        "entrypoint": d.entrypoint,
        "old_ref": d.old_ref,
        "new_ref": d.new_ref,
        "payload": payload,
        "payload_provenance": d.payload_provenance,
        "classifier_mode": d.classifier_mode,
        "vocab_size": d.vocab_size,
        "node_diffs": [
            {
                "status": nd.status,
                "kind": (nd.new_node or nd.old_node).kind
                if (nd.new_node or nd.old_node) else None,
                "label": (nd.new_node or nd.old_node).label
                if (nd.new_node or nd.old_node) else None,
                "operand_deltas": [
                    {"field": od.field, "old_value": od.old_value,
                     "new_value": od.new_value, "provenance": od.provenance}
                    for od in nd.operand_deltas
                ],
            }
            for nd in d.node_diffs
        ],
    }


def _flow_to_dict(flow: Flow) -> dict:
    return {
        "entrypoint": flow.entrypoint,
        "mode": flow.mode,
        "containment_level": flow.containment_level,
        "classifier_mode": flow.classifier_mode,
        "vocab_size": flow.vocab_size,
        "fallback_reason": flow.fallback_reason,
        "seed": flow.seed,
        "default_view": [n.label for n in flow.default_nodes()],
        "nodes": [_node_to_dict(n) for n in flow.nodes],
    }


def _node_to_dict(n: Node) -> dict:
    return {
        "kind": n.kind,
        "label": n.label,
        "business_meaningful": n.business_meaningful,
        "provenance": n.provenance,
        "operands": [
            {"name": o.name, "value": o.value, "provenance": o.provenance,
             "derived_from": o.derived_from}
            for o in n.operands
        ],
        "open_question": n.open_question,
        # observed run evidence (stdout/stderr), shown on expand — deterministic,
        # never a compared operand. None for silent runs (schema stays stable).
        "raw_detail": n.raw_detail,
    }


def to_html(flow: Flow) -> str:
    """Self-contained HTML view of the flow (spec §5): collapsed by default
    (business-meaningful nodes open, plumbing collapsed), expandable via native
    ``<details>``, contrasted. Attach to an MR so a reviewer sees the observed
    flow instead of reconstructing it from a diff. No JS dependency."""
    rows: list[str] = []
    for n in flow.nodes:
        ops = ", ".join(
            f"{html.escape(str(o.name))}={html.escape(repr(o.value))} [{o.provenance}]"
            for o in n.operands
        ) or "<span class='notmean'>(no operands)</span>"
        cls = "mean" if n.business_meaningful else "notmean"
        marker = "★" if n.business_meaningful else "·"
        open_attr = " open" if n.business_meaningful else ""
        q = f"<div class='q'>{html.escape(n.open_question)}</div>" if n.open_question else ""
        detail = (
            f"<pre class='detail'>{html.escape(n.raw_detail)}</pre>" if n.raw_detail else ""
        )
        rows.append(
            f"<details{open_attr} class='{cls}'><summary><b>{marker} {html.escape(n.kind)}: "
            f"{html.escape(n.label)}</b> — {ops}</summary>{q}{detail}</details>"
        )
    seen: set[str] = set()
    questions = [q for n in flow.nodes if n.open_question and not (q := n.open_question) in seen and not seen.add(q)]
    qblock = (
        "<div class='qbox'><b>Open questions — you adjudicate (no verdicts here):</b><ul>"
        + "".join(f"<li>{html.escape(q)}</li>" for q in questions)
        + "</ul></div>"
        if questions
        else ""
    )
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>dreplay flow — {html.escape(flow.entrypoint)}</title>"
        "<style>body{font-family:system-ui,sans-serif;max-width:920px;margin:2em auto;color:#222}"
        "details{margin:2px 0;padding:6px 10px;border-radius:4px}"
        "details.mean{background:#eef6ff;border:1px solid #bcd} details.notmean{color:#888}"
        ".q{margin-top:4px;color:#555} h1{margin-bottom:0} "
        ".qbox{background:#fff8e6;border:1px solid #e0c060;padding:8px 14px;border-radius:4px;margin-top:1.4em}"
        ".qbox li{margin:4px 0} code{background:#f4f4f4;padding:1px 4px;border-radius:3px} "
        ".detail{background:#f7f7f7;border-left:3px solid #ccc;padding:6px 10px;margin-top:6px;"
        "font-size:.85em;white-space:pre-wrap;overflow-x:auto;max-height:22em}</style></head><body>"
        f"<h1>Observed flow</h1><div><small>entrypoint <code>{html.escape(flow.entrypoint)}</code> · "
        f"mode {html.escape(flow.mode)} · containment {html.escape(flow.containment_level)}</small></div>"
        "<h2>flow <small>(★ business-meaningful, open by default · · plumbing, collapsed — click to expand)</small></h2>"
        + "".join(rows)
        + qblock
        + "</body></html>"
    )


# --------------------------------------------------------------------------- #
# Flow-diff rendering (spec §9.3) — used by the --diff CLI mode.
#
# This is the plain-text diff renderer the CLI uses (the interactive TUI for the
# diff is a separate task). It delegates the alignment verdicts to the
# :class:`FlowDiff` (computed by :func:`dreplay.flow_diff.align_and_diff`) and
# only renders what the alignment already decided — it never judges. It carries
# operand provenance verbatim and ends every question with the neutral
# ``... — intended?``.
# --------------------------------------------------------------------------- #
# Status icon per spec §9.3. The alignment statuses come from NodeDiff.status.
_STATUS_ICON = {
    "added": "+",
    "removed": "-",
    "changed": "~",
    "moved": ">",
    "unchanged": "·",
}
_QUESTION_SUFFIX = " — intended?"


def _format_payload(payload: object) -> str:
    """Compact, single-line view of the shared input shape for the header.

    A :class:`~dreplay.flow_diff.FlowDiff`'s ``payload`` is a
    :class:`~dreplay.types.CanonicalValue`; render its ``.shape`` (the canonical
    representation) rather than the internal repr, so the header is readable.
    """
    shape = getattr(payload, "shape", payload)
    try:
        return json.dumps(shape, default=str, sort_keys=True)
    except (TypeError, ValueError):
        return repr(shape)


def _render_operand_deltas(deltas: tuple[OperandDelta, ...]) -> list[str]:
    lines: list[str] = []
    for d in deltas:
        lines.append(
            f"      {d.field}: {d.old_value!r} -> {d.new_value!r} [{d.provenance}]"
        )
        lines.append(f"        ? {d.field} changed{_QUESTION_SUFFIX}")
    return lines


def _node_open_question(nd: NodeDiff) -> str | None:
    """The open question to surface for a changed/added/removed node, if any."""
    node = nd.new_node or nd.old_node
    if node is None or not node.open_question:
        return None
    q = node.open_question
    # Normalize to the neutral close without a verdict word.
    return q if q.endswith("intended?") else q + _QUESTION_SUFFIX


def render_diff(flow_diff: FlowDiff) -> str:
    """Plain-text rendering of a :class:`FlowDiff`.

    Layout:
      * header — entrypoint, old->new refs, payload, classifier mode
      * per-node diff — status icon, label, operand deltas
      * open questions on changed/added/removed nodes
      * honest empty-state when there are zero changes

    Emits no verdict words: the only question is the literal neutral
    ``... — intended?``. (Verdict-word guarding is already enforced inside
    :func:`dreplay.flow_diff.render_flow_diff`; this renderer reuses the same
    invariant by only emitting neutral text.)
    """
    lines: list[str] = []

    # ---- Header ----
    lines.append(
        f"flow-diff: {flow_diff.entrypoint}   "
        f"classifier={flow_diff.classifier_mode} (vocab={flow_diff.vocab_size})"
    )
    old_ref = flow_diff.old_ref if flow_diff.old_ref is not None else "(working tree)"
    new_ref = flow_diff.new_ref if flow_diff.new_ref is not None else "(working tree)"
    lines.append(f"  old: {old_ref}   ->   new: {new_ref}")
    lines.append(f"  payload: {_format_payload(flow_diff.payload)}")

    # ---- Honest empty-state ----
    changes = [nd for nd in flow_diff.node_diffs if nd.status != "unchanged"]
    if not changes:
        lines.append("")
        lines.append(flow_diff.honest_message())
        return "\n".join(lines)

    lines.append(
        f"  {len(changes)} node change(s) across {len(flow_diff.node_diffs)} aligned node(s)"
    )
    lines.append("")

    # ---- Per-node diff ----
    questions: list[str] = []
    for nd in flow_diff.node_diffs:
        icon = _STATUS_ICON.get(nd.status, "?")
        if nd.status == "unchanged":
            node = nd.new_node or nd.old_node
            kind = node.kind if node else "?"
            label = node.label if node else "?"
            lines.append(f"  {icon} {kind:<14} {label}")
        elif nd.status == "added":
            n = nd.new_node
            assert n is not None
            ops = "  ".join(f"{o.name}={o.value!r}" for o in n.operands)
            tail = f"   {ops}" if ops else ""
            lines.append(f"  {icon} {n.kind:<14} {n.label}{tail}")
            q = _node_open_question(nd)
            if q:
                questions.append(q)
        elif nd.status == "removed":
            n = nd.old_node
            assert n is not None
            ops = "  ".join(f"{o.name}={o.value!r}" for o in n.operands)
            tail = f"   {ops}" if ops else ""
            lines.append(f"  {icon} {n.kind:<14} {n.label}{tail}")
            q = _node_open_question(nd)
            if q:
                questions.append(q)
        elif nd.status == "changed":
            n = nd.new_node
            assert n is not None
            lines.append(f"  {icon} {n.kind:<14} {n.label}")
            lines.extend(_render_operand_deltas(nd.operand_deltas))
            q = _node_open_question(nd)
            if q:
                questions.append(q)
        elif nd.status == "moved":
            n = nd.new_node
            assert n is not None
            lines.append(f"  {icon} {n.kind:<14} {n.label} (position changed)")
            questions.append(f"position of {n.label} changed{_QUESTION_SUFFIX}")

    # ---- Open questions ----
    if questions:
        lines.append("")
        lines.append("open questions (you adjudicate — no verdicts here):")
        # de-dup while preserving order
        seen: set[str] = set()
        for q in questions:
            if q not in seen:
                seen.add(q)
                lines.append(f"  ? {q}")

    return "\n".join(lines)
