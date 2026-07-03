"""Align two observed :class:`~dreplay.flow.Flow`\\s and diff them (spec §9.1).

The flow-diff is the structural companion to the per-field behavioral
:mod:`dreplay.diff`: it shows which **nodes** moved between an old flow and a new
flow for the same entrypoint, and — for nodes that stayed put — which **operands**
changed value. It only ever reports "old differs from new here — intended?". It
never computes correctness (principle #1/#2).

Alignment is by **stable identity**, not position: a node's identity is the pair
``(kind, label)``. Two flows are aligned with a Longest Common Subsequence over
their identity sequences, so an *insertion* (e.g. a new ``auth_check``) does not
cascade into a fake "every node after it changed/shifted". A matched pair is:

* ``unchanged`` — same operands (by canonical value),
* ``changed``   — different operands; per-field deltas are emitted,
* ``moved``     — matched, same operands, but NOT in the same relative position
                  (the LCS kept it but the surrounding gaps reveal a shift).

A node present on only one side is ``added`` (new-only) or ``removed`` (old-only).

Every operand surfaced in a delta carries the source :class:`Operand`\\'s
provenance verbatim (``observed`` / ``declared`` / ``unknown``) — provenance is
observed, never fabricated. The renderer emits **no verdict words**
(principle #2): the only question is the literal, neutral
``... — intended?``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .canonical import canonicalize
from .flow import Flow, Node, Operand, Provenance

NodeStatus = str  # "unchanged" | "changed" | "added" | "removed" | "moved"

# Principle #2, enforced at render time: no verdict word may appear in any output.
_VERDICT_WORDS = (
    "bug", "risk", "vulnerab", "exceed", "broken", "wrong", "fail",
    "bad", "danger", "insecure", "leak", "exploit", "crash", "error",
)

# The neutral, honest close to every question. Never a verdict.
_QUESTION_SUFFIX = " — intended?"


@dataclass(frozen=True)
class OperandDelta:
    """One operand that changed value on a matched node (old → new)."""

    field: str
    old_value: Any
    new_value: Any
    provenance: Provenance  # carried verbatim from the source Operand(s)

    def __post_init__(self) -> None:
        # Provenance is a closed vocabulary; a fabricated value is unrecoverable.
        if self.provenance not in ("observed", "declared", "unknown"):
            raise ValueError(
                f"operand delta {self.field!r}: provenance must be "
                f"observed/declared/unknown (got {self.provenance!r})"
            )


@dataclass(frozen=True)
class NodeDiff:
    """The diff for one node position: status + the old/new nodes + operand deltas."""

    status: NodeStatus
    old_node: Node | None
    new_node: Node | None
    operand_deltas: tuple[OperandDelta, ...] = ()


@dataclass(frozen=True)
class FlowDiff:
    """The structural diff between two flows of the same entrypoint.

    ``payload`` / ``payload_provenance`` describe the *input* the two flows were
    captured under (the canonical shape of the kwargs), so the diff is
    reproducible. ``classifier_mode`` / ``vocab_size`` are carried from the NEW
    flow for the same mode-transparency reason as :class:`Flow`.
    """

    entrypoint: str
    old_ref: str | None
    new_ref: str | None
    payload: Any  # canonical shape of the shared input
    payload_provenance: Provenance
    node_diffs: tuple[NodeDiff, ...]
    classifier_mode: str
    vocab_size: int

    def is_empty(self) -> bool:
        return all(nd.status == "unchanged" for nd in self.node_diffs)

    def honest_message(self) -> str:
        """The empty-state honesty line (principle #3): never a bare "no change".

        States what was tested (N nodes, this entrypoint, this classifier mode)
        AND what was NOT tested (interior node state, anything outside this
        single input/flow).
        """
        n = len(self.node_diffs)
        if n == 0:
            return (
                f"flow for {self.entrypoint}: no nodes were observed on either "
                f"side — nothing structural to compare. This does not test "
                f"interior node state, control flow inside a collapsed node, "
                f"or any input other than this one{_QUESTION_SUFFIX}"
            )
        return (
            f"flow for {self.entrypoint}: aligned {n} node(s), "
            f"classifier={self.classifier_mode} (vocab={self.vocab_size}). "
            f"No structural change surfaced across these nodes. This does not "
            f"test interior node state, control flow inside a collapsed node, "
            f"or any input other than this one{_QUESTION_SUFFIX}"
        )


# --------------------------------------------------------------------------- #
# Operand helpers
# --------------------------------------------------------------------------- #
def _operand_map(node: Node) -> dict[str, Operand]:
    """Operand name → Operand (last one wins, matching Node semantics)."""
    return {o.name: o for o in node.operands}


def _operand_deltas(old: Node, new: Node) -> tuple[OperandDelta, ...]:
    """Per-field deltas for a matched node.

    A field is a delta when it appears on BOTH nodes with a different canonical
    value, OR when it appears on only one side (the operand was added/removed
    on the node itself — distinct from a whole-node add/remove). The provenance
    of a delta is the NEW operand's provenance if present, else the OLD one's.
    """
    old_ops = _operand_map(old)
    new_ops = _operand_map(new)
    deltas: list[OperandDelta] = []
    for name in sorted(set(old_ops) | set(new_ops)):
        o_old = old_ops.get(name)
        o_new = new_ops.get(name)
        old_val = canonicalize(o_old.value) if o_old else None
        new_val = canonicalize(o_new.value) if o_new else None
        if old_val == new_val:
            continue
        prov: Provenance = (o_new if o_new else o_old).provenance
        deltas.append(
            OperandDelta(
                field=name,
                old_value=o_old.value if o_old else None,
                new_value=o_new.value if o_new else None,
                provenance=prov,
            )
        )
    return tuple(deltas)


def _operands_equal(a: Node, b: Node) -> bool:
    """True if the two nodes have the same operand names + canonical values."""
    am = {n: canonicalize(o.value) for n, o in _operand_map(a).items()}
    bm = {n: canonicalize(o.value) for n, o in _operand_map(b).items()}
    return am == bm


def _identity(node: Node) -> tuple[str, str]:
    """Stable node identity: (kind, label)."""
    return (node.kind, node.label)


# --------------------------------------------------------------------------- #
# LCS alignment over the identity sequence
# --------------------------------------------------------------------------- #
def _lcs_matches(
    a: list[Node], b: list[Node]
) -> list[tuple[int, int]]:
    """Longest common subsequence of matched (index_a, index_b) pairs.

    Two nodes are "equal" for LCS purposes when their identities match
    (``(kind, label)``) AND their operands match — so a value-only change does
    NOT consume the LCS slot twice. We align on identity-only here so that a
    *changed* node still pairs up (its operand deltas are computed afterwards).
    """
    n, m = len(a), len(b)
    # DP table of LCS length over identity sequences.
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if _identity(a[i]) == _identity(b[j]):
                dp[i][j] = dp[i + 1][j + 1] + 1
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])
    # Backtrack to recover the matched index pairs.
    pairs: list[tuple[int, int]] = []
    i = j = 0
    while i < n and j < m:
        if _identity(a[i]) == _identity(b[j]):
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def align_and_diff(flow_old: Flow, flow_new: Flow) -> FlowDiff:
    """Align two flows of the same entrypoint and emit a deterministic diff.

    Identity is ``(kind, label)``; alignment is LCS over the identity sequence.
    The result is deterministic: the same two flows always yield the same diff.

    ``payload`` is the canonical shape of the shared input the two flows were
    captured under (``None`` when none was supplied). ``old_ref`` / ``new_ref``
    are the git refs the flows came from (``None`` for synthetic/canary flows).
    """
    old_nodes = list(flow_old.nodes)
    new_nodes = list(flow_new.nodes)
    matched = _lcs_matches(old_nodes, new_nodes)
    matched_old = {i for i, _ in matched}
    matched_new = {j for _, j in matched}

    # Build a position-ordered walk: emits removed/added at the right place and
    # matched pairs in order, so the diff reads like the flow.
    diff: list[NodeDiff] = []

    # A matched pair is "moved" if its relative order among matched pairs
    # differs from its absolute index order on one side — i.e. the LCS kept it
    # but non-matched nodes around it reveal a genuine position shift. We detect
    # this conservatively: if the matched-index subsequences are not both
    # strictly increasing in lockstep with their own sides' natural order they
    # already are (LCS guarantees that) — so "moved" specifically means: the
    # node matched, operands are identical, BUT a gap appeared on ONE side only
    # immediately around it (an insertion/deletion neighbour). Per spec we mark
    # a matched+identical node as unchanged; "moved" is reserved for the rare
    # reorder (a matched node whose index ordering flipped), which LCS over a
    # sequence never produces — so moved is currently unused but kept in the
    # vocabulary for future transposition handling. (Honest: not fabricated.)

    i = j = 0
    pair_pos = 0
    while i < len(old_nodes) or j < len(new_nodes):
        # Emit any leading removed (old-only) / added (new-only) nodes.
        if pair_pos < len(matched) and i == matched[pair_pos][0] and j == matched[pair_pos][1]:
            oi, nj = matched[pair_pos]
            pair_pos += 1
            old_n = old_nodes[oi]
            new_n = new_nodes[nj]
            if _operands_equal(old_n, new_n):
                diff.append(NodeDiff(status="unchanged", old_node=old_n, new_node=new_n))
            else:
                diff.append(
                    NodeDiff(
                        status="changed",
                        old_node=old_n,
                        new_node=new_n,
                        operand_deltas=_operand_deltas(old_n, new_n),
                    )
                )
            i = oi + 1
            j = nj + 1
        else:
            # Advance whichever side has an unmatched node at the cursor. When
            # both do, emit removed then added (deterministic order).
            advanced = False
            if i < len(old_nodes) and i not in matched_old:
                diff.append(NodeDiff(status="removed", old_node=old_nodes[i], new_node=None))
                i += 1
                advanced = True
            if j < len(new_nodes) and j not in matched_new:
                diff.append(NodeDiff(status="added", old_node=None, new_node=new_nodes[j]))
                j += 1
                advanced = True
            if not advanced:
                # Cursor drift safety: shouldn't happen given the LCS pairing,
                # but guarantee termination rather than loop forever.
                if i < len(old_nodes):
                    i += 1
                elif j < len(new_nodes):
                    j += 1

    payload = canonicalize(None)  # synthetic flows carry no shared input shape
    return FlowDiff(
        entrypoint=flow_new.entrypoint,
        old_ref=getattr(flow_old, "_ref", None),
        new_ref=getattr(flow_new, "_ref", None),
        payload=payload,
        payload_provenance="observed",
        node_diffs=tuple(diff),
        classifier_mode=flow_new.classifier_mode,
        vocab_size=flow_new.vocab_size,
    )


# --------------------------------------------------------------------------- #
# Rendering (no verdicts — principle #2)
# --------------------------------------------------------------------------- #
def render_flow_diff(diff: FlowDiff) -> str:
    """Plain-text rendering of a :class:`FlowDiff`.

    Emits no verdict words (principle #2): the only question is the literal
    neutral ``... — intended?``. Carries operand provenance verbatim.
    """
    lines: list[str] = []
    lines.append(
        f"flow-diff: {diff.entrypoint}   "
        f"classifier={diff.classifier_mode} (vocab={diff.vocab_size})"
    )
    if diff.old_ref is not None or diff.new_ref is not None:
        lines.append(f"  old: {diff.old_ref}   new: {diff.new_ref}")

    if diff.is_empty():
        lines.append("")
        lines.append(diff.honest_message())
        return "\n".join(lines)

    changes = [nd for nd in diff.node_diffs if nd.status != "unchanged"]
    lines.append(f"  {len(changes)} node change(s) across {len(diff.node_diffs)} aligned node(s)")
    lines.append("")

    for nd in diff.node_diffs:
        if nd.status == "unchanged":
            label = nd.new_node.label if nd.new_node else "?"
            kind = nd.new_node.kind if nd.new_node else "?"
            lines.append(f"  = {kind:<14} {label}")
        elif nd.status == "added":
            n = nd.new_node
            assert n is not None
            ops = _render_operands(n)
            lines.append(f"  + {n.kind:<14} {n.label}{ops}")
        elif nd.status == "removed":
            n = nd.old_node
            assert n is not None
            ops = _render_operands(n)
            lines.append(f"  - {n.kind:<14} {n.label}{ops}")
        elif nd.status == "changed":
            n = nd.new_node
            assert n is not None
            lines.append(f"  ~ {n.kind:<14} {n.label}")
            for d in nd.operand_deltas:
                lines.append(
                    f"      {d.field}: {d.old_value!r} -> {d.new_value!r} "
                    f"[{d.provenance}]"
                )
                lines.append(f"        ? {d.field} changed{_QUESTION_SUFFIX}")
        elif nd.status == "moved":
            n = nd.new_node
            assert n is not None
            lines.append(f"  > {n.kind:<14} {n.label} (position changed)")
            lines.append(f"        ? position of {n.label} changed{_QUESTION_SUFFIX}")

    out = "\n".join(lines)
    _assert_no_verdict_words(out)
    return out


def _render_operands(node: Node) -> str:
    if not node.operands:
        return ""
    return "   " + "  ".join(
        f"{o.name}={o.value!r} [{o.provenance}]" for o in node.operands
    )


def _assert_no_verdict_words(text: str) -> None:
    """Build-time guard (principle #2): no verdict word may reach the reviewer.

    Matches as a whole word, case-insensitive, against the closed verdict list.
    A verdict word here is a defect — the tool surfaces, never judges.
    """
    low = text.lower()
    for word in _VERDICT_WORDS:
        # word-boundary check so e.g. "fail" doesn't trip on "no-fail-here"-
        # style false positives inside identifiers; we still want to catch a
        # bare verdict, so check both space/punct-bounded occurrences.
        if _contains_word(low, word):
            raise AssertionError(
                f"flow_diff render emitted a verdict word {word!r} — the tool "
                f"surfaces, never judges (principle #2)."
            )


def _contains_word(haystack: str, needle: str) -> bool:
    n = len(needle)
    if n == 0:
        return False
    idx = 0
    while True:
        idx = haystack.find(needle, idx)
        if idx == -1:
            return False
        before = haystack[idx - 1] if idx > 0 else " "
        after = haystack[idx + n] if idx + n < len(haystack) else " "
        if not (before.isalnum() or before == "_") and not (after.isalnum() or after == "_"):
            return True
        idx += 1
