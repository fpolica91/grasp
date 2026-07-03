"""Conformance test for the Go FLOW-mode adapter (spec §2).

Pins the honesty contract for the Go adapter:

* the ``input`` node (kwargs) is OBSERVED;
* interior call/return nodes (e.g. ``tag``) are OBSERVED via source instrumentation
  (go/ast rewrite), NOT synthesized;
* the ``return`` node binds the entrypoint's returned business fields, OBSERVED;
* every operand provenance is one of observed/declared/unknown (the type-system guard
  in ``Operand.__post_init__`` enforces this at construction — a guessed operand
  raises at construction, so a passing test cannot contain one);
* the vocab deriver reads the Go ``struct`` declarations and the classifier runs in
  VOCAB mode (the schema-derived precision the product is about).

If ``go`` is not on PATH, the whole module skips — the adapter is a proof-of-seam and
is NEVER faked (principle #7, docs/what-this-is.md §1).
"""
from __future__ import annotations

import os
import shutil

import pytest

from dreplay.adapter import go_trace
from dreplay.adapter.go_flow import derive_go_vocabulary, go_flow
from dreplay.flow import Flow, Operand

_HERE = os.path.dirname(os.path.abspath(__file__))
_SAMPLE_GO = os.path.join(_HERE, "fixtures", "go", "sample.go")

pytestmark = pytest.mark.skipif(
    shutil.which("go") is None or not go_trace.available(),
    reason="go toolchain + instrumenter required for the Go adapter",
)


def test_go_flow_observes_interior_call_and_return() -> None:
    """classify(x) calls tag(x) interior; both must be OBSERVED, return binds fields."""
    flow: Flow = go_flow(module_path=_SAMPLE_GO, func="classify", kwargs={"x": 5})

    labels = [n.label for n in flow.nodes]
    # The entrypoint frame is skipped by the reducer (covered by input/return);
    # the interior tag() helper MUST appear as an observed node.
    assert "tag" in labels, f"interior tag() call must be traced; got {labels}"
    tag_node = next(n for n in flow.nodes if n.label == "tag")
    assert tag_node.provenance == "observed", "interior node must be observed, not synthesized"

    # The return node binds the observed business fields.
    ret = next((n for n in flow.nodes if n.kind == "return"), None)
    assert ret is not None, "a return node must be present"
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands), (
        f"return must bind tag='pos'; got {ret.operands}"
    )
    assert any(o.name == "ok" and o.value is True for o in ret.operands), (
        f"return must bind ok=true; got {ret.operands}"
    )


def test_go_flow_no_operand_is_guessed() -> None:
    """Principle #1: every operand provenance is observed/declared/unknown — the
    Operand type-system guard raises on anything else, so iterating without error
    proves no guessed operand exists anywhere in the flow."""
    flow = go_flow(module_path=_SAMPLE_GO, func="classify", kwargs={"x": 7})
    valid = {"observed", "declared", "unknown"}
    for op in flow.all_operands():
        assert op.provenance in valid, f"bad provenance: {op}"


def test_go_flow_input_node_observed() -> None:
    """The kwargs are the OBSERVED input — a business-meaningful input node."""
    flow = go_flow(module_path=_SAMPLE_GO, func="classify", kwargs={"x": 3})
    inp = next((n for n in flow.nodes if n.kind == "input"), None)
    assert inp is not None and inp.business_meaningful
    assert any(o.name == "x" and o.value == 3 for o in inp.operands), (
        f"input must bind x=3; got {inp.operands}"
    )


def test_go_vocab_derives_struct_fields() -> None:
    """The vocab deriver reads the Go Order struct → its field names."""
    src = open(_SAMPLE_GO, encoding="utf-8").read()
    fields = derive_go_vocabulary(src)
    for expected in ("Amount", "Currency", "Status"):
        assert expected in fields, f"struct field {expected} must be derived; got {fields}"


def test_go_flow_uses_vocab_mode_when_structs_present() -> None:
    """With Go structs declared, the classifier runs in VOCAB mode (mode transparency)."""
    flow = go_flow(module_path=_SAMPLE_GO, func="classify", kwargs={"x": 5})
    assert flow.classifier_mode == "vocab", (
        f"classifier should be vocab when structs are declared; got {flow.classifier_mode}"
    )
    assert flow.vocab_size >= 3, f"vocab should include struct fields; got {flow.vocab_size}"


def test_go_flow_handles_panic() -> None:
    """A panicking entrypoint yields an observed exception, not a crash/synthesis."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".go", delete=False, encoding="utf-8") as tf:
        tf.write(
            "package main\n"
            "func boom(x int) string {\n"
            "  panic(\"boom\")\n"
            "  return \"unreachable\"\n"
            "}\n"
        )
        path = tf.name
    try:
        flow = go_flow(module_path=path, func="boom", kwargs={"x": 1})
        assert any(n.kind == "other" for n in flow.nodes), "panic must surface as a node"
    finally:
        os.unlink(path)


_SAMPLE_IMPORTS_GO = os.path.join(_HERE, "fixtures", "go", "sample_imports.go")


def test_go_flow_compiles_with_multiline_import_block() -> None:
    """Regression (ultracode probe, 2026-07-02): a real .go file with an
    `import (` block and a func main() must COMPILE and RUN — the target's
    strings/fmt imports must survive the strip, and main() must be removed.
    Before the fix the block was never entered, imports leaked as bare
    statements, and the entrypoint never executed (endpoints-only fallback)."""
    flow: Flow = go_flow(module_path=_SAMPLE_IMPORTS_GO, func="Describe",
                         kwargs={"name": "widget", "count": 3})
    labels = [n.label for n in flow.nodes]
    assert "instrumentation-error" not in labels, (
        f"import-block file must compile+run, not fall back; got {labels}"
    )
    ret = next(n for n in flow.nodes if n.kind == "return")
    vals = {o.name: o.value for o in ret.operands}
    # strings.ToUpper + fmt.Sprintf actually executed
    assert vals.get("label") == "WIDGET"
    assert vals.get("pretty") == "WIDGET x3"


def test_go_endpoints_fallback_is_instrumentation_error_not_clean() -> None:
    """Regression: a run that never executed (unreadable source) must surface an
    instrumentation-error node (drives non-zero exit), NOT an 'interior-
    unobservable' note that reads as an observed-clean endpoints run."""
    flow = go_flow(module_path="/nonexistent/does_not_exist.go", func="F", kwargs={})
    labels = [n.label for n in flow.nodes]
    assert "instrumentation-error" in labels
    assert "interior-unobservable" not in labels
    # input node label is func-only (path-free) so a diff won't phantom-change
    inp = next(n for n in flow.nodes if n.kind == "input")
    assert inp.label == "F"
