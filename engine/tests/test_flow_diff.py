"""Flow-diff CANARIES (spec §9.1).

These exercise :func:`dreplay.flow_diff.align_and_diff` against synthetic
:class:`~dreplay.flow.Flow` pairs built directly — no git, no instrumentation.
They pin the alignment contract:

  (a) a value change on a matched node → ``changed`` + an operand delta
  (b) an insertion mid-flow → exactly ONE ``added`` node (no tail cascade)
  (c) an identical refactor → all ``unchanged``
  (d) identical old/new → empty diff + an honest (non-bare) message
  (e) every operand delta carries valid provenance
  (f) no verdict word appears in any rendered output

The alignment engine lives in the same module under test; the canaries must
PASS.
"""
from __future__ import annotations

from dreplay.flow import Flow, Node, Operand
from dreplay.flow_diff import (
    FlowDiff,
    NodeDiff,
    OperandDelta,
    align_and_diff,
    render_flow_diff,
)

_VALID_PROVENANCE = ("observed", "declared", "unknown")
# Matches the verdict list in dreplay/flow_diff.py — duplicated here so the
# canary independently fails if a verdict word leaks into rendered output.
_VERDICT_WORDS = (
    "bug", "risk", "vulnerab", "exceed", "broken", "wrong", "fail",
    "bad", "danger", "insecure", "leak", "exploit", "crash", "error",
)


# --------------------------------------------------------------------------- #
# Flow fixtures
# --------------------------------------------------------------------------- #
def _owner_null_flow(owner: object = None) -> Flow:
    """input → db_write(owner) → return. The owner=NULL daily-driver shape."""
    return Flow(
        entrypoint="app.create_org",
        mode="instant",
        nodes=(
            Node(
                kind="input",
                label="create_org",
                operands=(Operand(name="name", value="x", provenance="observed"),),
                business_meaningful=True,
            ),
            Node(
                kind="db_write",
                label="_save",
                operands=(Operand(name="owner", value=owner, provenance="observed"),),
                business_meaningful=True,
                open_question=(
                    "write binds owner = NULL — intended?" if owner is None else None
                ),
            ),
            Node(
                kind="return",
                label="create_org",
                operands=(Operand(name="owner", value=owner, provenance="observed"),),
                business_meaningful=True,
            ),
        ),
        containment_level="none",
    )


def _insert_auth_flow() -> Flow:
    """input → auth_check → db_write → return (auth_check inserted mid-flow)."""
    return Flow(
        entrypoint="app.create_org",
        mode="instant",
        nodes=(
            Node(
                kind="input",
                label="create_org",
                operands=(Operand(name="name", value="x", provenance="observed"),),
                business_meaningful=True,
            ),
            Node(
                kind="auth_check",
                label="_require_owner",
                operands=(Operand(name="actor", value="system", provenance="observed"),),
                business_meaningful=True,
            ),
            Node(
                kind="db_write",
                label="_save",
                operands=(Operand(name="owner", value=None, provenance="observed"),),
                business_meaningful=True,
                open_question="write binds owner = NULL — intended?",
            ),
            Node(
                kind="return",
                label="create_org",
                operands=(Operand(name="owner", value=None, provenance="observed"),),
                business_meaningful=True,
            ),
        ),
        containment_level="none",
    )


def _assert_no_verdict(text: str) -> None:
    low = text.lower()
    for w in _VERDICT_WORDS:
        # word-boundary check so legit substrings (e.g. an identifier) don't
        # mask a real bare verdict, and vice-versa.
        assert not _has_word(low, w), (
            f"rendered flow-diff contains verdict word {w!r}: {text!r}"
        )


def _has_word(haystack: str, needle: str) -> bool:
    n = len(needle)
    idx = 0
    while True:
        idx = haystack.find(needle, idx)
        if idx == -1:
            return False
        before = haystack[idx - 1] if idx > 0 else " "
        after = haystack[idx + n] if idx + n < len(haystack) else " "
        if not (before.isalnum() or before == "_") and not (
            after.isalnum() or after == "_"
        ):
            return True
        idx += 1


# --------------------------------------------------------------------------- #
# Canary (a): owner NULL → 42 on a matched db_write node
# --------------------------------------------------------------------------- #
def test_owner_null_to_42_is_a_changed_node_delta() -> None:
    old = _owner_null_flow(owner=None)
    new = _owner_null_flow(owner=42)

    diff = align_and_diff(old, new)

    save = next(nd for nd in diff.node_diffs if nd.new_node and nd.new_node.label == "_save")
    assert save.status == "changed", (
        f"a db_write whose owner moved None→42 must be 'changed', got {save.status!r}"
    )
    deltas = {d.field: d for d in save.operand_deltas}
    assert "owner" in deltas, "the changed operand (owner) must appear in the deltas"
    assert deltas["owner"].old_value is None
    assert deltas["owner"].new_value == 42

    # The input and return nodes share the same operand change → they are
    # 'changed' too; but no node is added/removed.
    assert all(nd.status in ("unchanged", "changed") for nd in diff.node_diffs)
    assert not any(nd.status == "added" for nd in diff.node_diffs)
    assert not any(nd.status == "removed" for nd in diff.node_diffs)


# --------------------------------------------------------------------------- #
# Canary (b): an inserted auth_check is exactly ONE added node — no cascade
# --------------------------------------------------------------------------- #
def test_inserted_auth_check_is_one_added_no_tail_cascade() -> None:
    old = _owner_null_flow(owner=None)          # input, db_write, return
    new = _insert_auth_flow()                    # input, auth_check, db_write, return

    diff = align_and_diff(old, new)

    added = [nd for nd in diff.node_diffs if nd.status == "added"]
    removed = [nd for nd in diff.node_diffs if nd.status == "removed"]
    changed = [nd for nd in diff.node_diffs if nd.status == "changed"]

    assert len(added) == 1, (
        f"inserting one auth_check must yield exactly ONE added node, got {len(added)}"
    )
    assert added[0].new_node is not None
    assert added[0].new_node.kind == "auth_check"
    assert added[0].new_node.label == "_require_owner"

    # The load-bearing assertion: the db_write AFTER the insertion must MATCH
    # its old counterpart, not shift into 'added'. A naive positional diff would
    # cascade every node after the insertion into 'added'/'removed'.
    assert removed == [], "no node should be removed when one was only inserted"
    assert changed == [], (
        "matched nodes around an insertion must be unchanged, not 'changed' "
        "(a cascade would mislabel them)"
    )

    save = next(
        nd for nd in diff.node_diffs
        if nd.status == "unchanged" and nd.new_node and nd.new_node.label == "_save"
    )
    assert save.old_node is not None and save.new_node is not None
    assert save.old_node.kind == "db_write"


# --------------------------------------------------------------------------- #
# Canary (c): an identical refactor → all nodes unchanged
# --------------------------------------------------------------------------- #
def test_noop_refactor_yields_all_unchanged() -> None:
    flow = _owner_null_flow(owner=7)
    diff = align_and_diff(flow, flow)

    assert diff.node_diffs, "a non-trivial flow must produce node diffs"
    assert all(nd.status == "unchanged" for nd in diff.node_diffs), (
        f"identical flows must be all-unchanged, got "
        f"{[nd.status for nd in diff.node_diffs]}"
    )
    for nd in diff.node_diffs:
        assert nd.operand_deltas == ()


# --------------------------------------------------------------------------- #
# Canary (d): identical old/new → empty diff + honest message
# --------------------------------------------------------------------------- #
def test_identical_flows_empty_diff_with_honest_message() -> None:
    flow = _owner_null_flow(owner=None)
    diff = align_and_diff(flow, flow)

    assert diff.is_empty(), "identical flows must produce an empty diff"
    msg = diff.honest_message()
    # Principle #3: never a bare "no change" — must state scope + what was NOT tested.
    assert "intended?" in msg, "the honest message must end in the neutral question"
    assert "does not test" in msg, (
        "the empty-state message must state what was NOT tested (principle #3)"
    )
    # Must NOT claim completeness.
    assert "all" not in msg.lower() or "does not" in msg.lower()


# --------------------------------------------------------------------------- #
# Canary (e): every operand in the diff carries valid provenance
# --------------------------------------------------------------------------- #
def test_every_operand_delta_carries_valid_provenance() -> None:
    # Mix provenance kinds: observed, declared, unknown.
    old = Flow(
        entrypoint="app.update",
        mode="instant",
        nodes=(
            Node(
                kind="db_write",
                label="_save",
                operands=(
                    Operand(name="owner", value=None, provenance="observed"),
                    Operand(name="limit", value=5, provenance="declared"),
                ),
                business_meaningful=True,
            ),
        ),
        containment_level="none",
    )
    new = Flow(
        entrypoint="app.update",
        mode="instant",
        nodes=(
            Node(
                kind="db_write",
                label="_save",
                operands=(
                    Operand(name="owner", value=42, provenance="observed"),
                    Operand(name="limit", value=None, provenance="unknown"),
                    Operand(name="note", value="x", provenance="observed"),
                ),
                business_meaningful=True,
            ),
        ),
        containment_level="none",
    )

    diff = align_and_diff(old, new)
    changed = next(nd for nd in diff.node_diffs if nd.status == "changed")
    assert changed.operand_deltas, "the changed node must have operand deltas"

    for d in changed.operand_deltas:
        assert d.provenance in _VALID_PROVENANCE, (
            f"operand delta {d.field!r} has invalid provenance {d.provenance!r}"
        )

    # The new operand's provenance must be carried verbatim for present fields.
    by_field = {d.field: d for d in changed.operand_deltas}
    assert by_field["owner"].provenance == "observed"
    assert by_field["limit"].provenance == "unknown"  # new operand's provenance wins
    # A field present only on the new side is an operand-level add.
    assert "note" in by_field and by_field["note"].new_value == "x"


# --------------------------------------------------------------------------- #
# Canary (f): no verdict word appears in any rendered diff output
# --------------------------------------------------------------------------- #
def test_no_verdict_word_in_any_rendered_output() -> None:
    # Exercise every render path: empty, all-unchanged, changed, added, removed.
    flows_diffs = [
        align_and_diff(_owner_null_flow(owner=None), _owner_null_flow(owner=None)),  # empty
        align_and_diff(_owner_null_flow(owner=1), _owner_null_flow(owner=1)),        # unchanged
        align_and_diff(_owner_null_flow(owner=None), _owner_null_flow(owner=42)),    # changed
        align_and_diff(_owner_null_flow(owner=None), _insert_auth_flow()),           # added
        align_and_diff(_insert_auth_flow(), _owner_null_flow(owner=None)),           # removed
    ]
    for d in flows_diffs:
        rendered = render_flow_diff(d)
        _assert_no_verdict(rendered)


# --------------------------------------------------------------------------- #
# Canary: determinism — same flows → same diff (run twice, compare)
# --------------------------------------------------------------------------- #
def test_align_and_diff_is_deterministic() -> None:
    old = _owner_null_flow(owner=None)
    new = _insert_auth_flow()
    d1 = align_and_diff(old, new)
    d2 = align_and_diff(old, new)
    assert d1 == d2, "align_and_diff must be deterministic"
    assert [nd.status for nd in d1.node_diffs] == [
        "unchanged", "added", "unchanged", "unchanged"
    ], (
        f"alignment order must be stable, got {[nd.status for nd in d1.node_diffs]}"
    )
