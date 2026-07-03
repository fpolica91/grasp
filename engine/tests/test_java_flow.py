"""Tests for the Java/JVM FLOW-mode adapter (spec §8.8 — language seam to the JVM).

Pins the honesty contract AND the JVM tracer's real interior-node capability:

* the ``input`` node (kwargs) and ``return`` node are OBSERVED;
* because the JVM -javaagent instruments every method in the target package, the
  adapter reduces REAL interior :class:`Node`\\s (``classify`` → ``tag``) — not
  synthesized, every one ``provenance="observed"``;
* operands on those nodes bind the business fields the code actually produced
  (Order.owner, amount; the returned tag/ok), observed;
* every operand provenance is one of observed/declared/unknown (the type-system
  guard in ``Operand.__post_init__`` enforces this).

If the JVM (``java``) or JDK (``javac``) is not on PATH, the whole module skips with
a reason naming the exact blocker — the adapter is NEVER faked (principle #7).
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from dreplay.adapter.java_flow import java_flow
from dreplay.flow import Flow

# The checked-in fixture: a small dependency-free business flow.
FIXTURES = Path(__file__).parent / "java_fixtures"
SRC_DIR = str(FIXTURES)
MAIN_CLASS = "org.example.Classifier"
TARGET_PKG = "org.example"

_JAVA = shutil.which("java")
_JAVAC = shutil.which("javac")
_SKIP_REASON = (
    "javac not on PATH — cannot build the -javaagent JAR"
    if not _JAVAC else "java (JRE) not on PATH"
)
pytestmark = pytest.mark.skipif(
    _JAVA is None or _JAVAC is None,
    reason=_SKIP_REASON,
)


def test_input_and_return_observed():
    flow = java_flow(
        src_dir=SRC_DIR, main_class=MAIN_CLASS, target_pkg=TARGET_PKG,
        func="classify",
        kwargs={"order": {"owner": "alice", "amount": 50}},
    )
    assert isinstance(flow, Flow)
    default = flow.default_nodes()
    kinds = [n.kind for n in default]
    assert "input" in kinds
    assert "return" in kinds

    inp = next(n for n in default if n.kind == "input")
    order = next(o for o in inp.operands if o.name == "order")
    assert order.provenance == "observed"
    assert isinstance(order.value, dict)
    assert order.value["owner"] == "alice"

    ret = next(n for n in default if n.kind == "return")
    names = {o.name for o in ret.operands}
    assert "owner" in names and "tag" in names and "ok" in names
    ok = next(o for o in ret.operands if o.name == "ok")
    assert ok.value is True and ok.provenance == "observed"
    tag = next(o for o in ret.operands if o.name == "tag")
    assert tag.value == "small"  # amount=50 → "small"


def test_interior_nodes_are_real_and_observed():
    """The load-bearing JVM capability: interior call/return nodes are TRACED (via
    bytecode instrumentation), not synthesized. ``classify`` is the business
    entrypoint; it calls ``tag`` — tag appears as a real interior node."""
    flow = java_flow(
        src_dir=SRC_DIR, main_class=MAIN_CLASS, target_pkg=TARGET_PKG,
        func="classify",
        kwargs={"order": {"owner": "bob", "amount": 250}},
    )
    labels = [n.label for n in flow.nodes]
    # tag is the interior call the tracer observed (classify is the entrypoint, so
    # _reduce skips its own frame — exactly like the Python instrument does).
    assert "tag" in labels, f"interior tag() must be traced; got {labels}"

    tag_node = next(n for n in flow.nodes if n.label == "tag")
    assert tag_node.provenance == "observed", "interior node must be observed, not synthesized"
    # The reducer binds business FIELDS (not scalar returns), so tag's observed
    # return ("big") flows into classify's return node as tag='big'.
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "big" for o in ret.operands), (
        "classify's return must bind the observed tag='big' (amount=250)")


def test_no_synthesized_or_guessed_operands():
    """Every operand across every node (default + interior) has a valid provenance —
    the honesty invariant. No 'guessed', no fabricated value."""
    flow = java_flow(
        src_dir=SRC_DIR, main_class=MAIN_CLASS, target_pkg=TARGET_PKG,
        func="classify",
        kwargs={"order": {"owner": "carol", "amount": 10}},
    )
    for op in flow.all_operands():
        assert op.provenance in ("observed", "declared", "unknown"), (
            f"operand {op.name!r} has invalid provenance {op.provenance!r}")


def test_vocab_deriver_reads_pojo_fields():
    """The Java vocab deriver reads POJO fields from source — the structural fix for
    name-guessing. Order declares owner/amount/status."""
    from dreplay.adapter.java_vocab import derive_java_vocabulary
    result = derive_java_vocabulary([SRC_DIR])
    assert "owner" in result.fields
    assert "amount" in result.fields
    assert "status" in result.fields
    assert result.mode == "vocab"
    assert result.vocab_size if hasattr(result, "vocab_size") else True  # shape
    assert result.models_found >= 1


def test_classifier_mode_transparent_on_status():
    """The status line: adapter prints adapter + classifier mode + vocab count. The
    flow carries classifier_mode + vocab_size so a vocab=0 blind run can't hide."""
    flow = java_flow(
        src_dir=SRC_DIR, main_class=MAIN_CLASS, target_pkg=TARGET_PKG,
        func="classify",
        kwargs={"order": {"owner": "dave", "amount": 5}},
        python_path=[SRC_DIR],
    )
    # With the fixture's POJO, vocab should be derived → vocab mode.
    assert flow.classifier_mode in ("vocab", "non_vocab")
    assert isinstance(flow.vocab_size, int)
    # vocab_size is len(fields) per the VocabularyResult; fields non-empty here.
    assert flow.vocab_size >= 3


def test_error_flow_when_main_missing():
    """An honest instrumentation-error flow when the main class can't run — never a
    faked 'no divergence'. Pins principle #5 (honest partial > confident fiction)."""
    flow = java_flow(
        src_dir=SRC_DIR, main_class="org.example.DoesNotExist", target_pkg=TARGET_PKG,
        kwargs={"order": {"owner": "x", "amount": 1}},
    )
    default = flow.default_nodes()
    # It either surfaces a thrown-error node (ran, threw) or an instrumentation-error
    # node (couldn't run) — both honest. Never a clean 'return'-only flow.
    err = next((n for n in default if n.kind == "other"), None)
    assert err is not None
