"""Conformance test for the TypeScript / NestJS FLOW-mode adapter (spec §2, §8.8).

Pins the honesty contract for the TS adapter:

* the ``input`` node (kwargs) and ``return`` node are OBSERVED;
* because the adapter type-strips then AST-traces via the JS machinery, REAL
  interior :class:`Node`\\s are reduced (``charge`` → ``label``) — not synthesized,
  every one ``provenance="observed"``;
* operands on those nodes bind the business fields the code actually produced
  (Order.id/amount/currency; the returned tag/ok/total), observed;
* the vocab deriver reads the TS ``interface``/``type`` declarations →
  ``classifier_mode="vocab"`` with the right ``vocab_size``;
* every operand provenance is one of observed/declared/unknown (the type-system
  guard in ``Operand.__post_init__`` enforces this at construction).

Runtime requirements: ``node`` must be on PATH (the JS tracer runs under Node v22).
The authoritative type-stripper needs the ``typescript`` npm module resolvable
(e.g. installed in the target's ``node_modules``); without it the regex fallback
handles simple-typed sources. If ``node`` is absent the whole module skips with a
reason naming the exact blocker — the adapter is NEVER faked (principle #7).
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

from dreplay.adapter.ts_flow import (
    derive_ts_vocabulary,
    status_line,
    ts_flow,
)
from dreplay.ts_strip import strip_types_best_effort, typescript_module_available
from dreplay.flow import Flow

# The checked-in fixture: a small typed business flow.
FIXTURES = Path(__file__).parent / "ts_fixtures"
ORDER_TS = FIXTURES / "order.ts"

_NODE = shutil.which("node")
_SKIP_REASON = "node not on PATH — TypeScript adapter cannot run the JS tracer"
pytestmark = pytest.mark.skipif(_NODE is None, reason=_SKIP_REASON)


def _has_typescript_module() -> bool:
    """True iff the `typescript` npm module is resolvable somewhere, so the
    authoritative tsc-transpile path is available (else regex fallback)."""
    candidates = [
        [],
        [str(FIXTURES)],
        [str(Path(__file__).parent)],
        [str(Path(__file__).parent.parent)],  # repo root (node_modules at root)
    ]
    return any(typescript_module_available(p) for p in candidates)


def _ts_search_paths() -> list[str]:
    """Dirs whose node_modules may hold `typescript`, in probe order."""
    return [str(FIXTURES), str(Path(__file__).parent), str(Path(__file__).parent.parent)]


# --------------------------------------------------------------------------- #
# Vocab deriver — pure source read, no runtime needed (but module skip covers node)
# --------------------------------------------------------------------------- #
def test_vocab_deriver_reads_interface_and_type_fields() -> None:
    """The vocab deriver reads field names from `interface` + `type` declarations."""
    fields = derive_ts_vocabulary([str(ORDER_TS)])
    expected = {"id", "amount", "currency", "ok", "tag", "total"}
    assert expected <= fields, f"missing vocab fields: {expected - fields}"
    # Plumbing/method names must NOT leak in.
    assert "label" not in fields and "charge" not in fields
    assert "constructor" not in fields


# --------------------------------------------------------------------------- #
# Core conformance — the typed function traces to a real interior Flow
# --------------------------------------------------------------------------- #
def test_typed_function_traces_interior_nodes() -> None:
    """A typed TS function with an interface param traces REAL interior nodes:
    `charge` → `label`, all observed; the return binds the business fields."""
    flow = ts_flow(
        source_path=str(ORDER_TS),
        func="charge",
        kwargs={"o": {"id": "ord_1", "amount": 10, "currency": "USD"}},
        search_paths=_ts_search_paths(),
    )
    assert isinstance(flow, Flow)

    # The input node is observed.
    inp = next(n for n in flow.nodes if n.kind == "input")
    assert inp.provenance == "observed"
    o_op = next(op for op in inp.operands if op.name == "o")
    assert o_op.value["id"] == "ord_1"  # type: ignore[index]

    # The interior `label` helper IS traced (the load-bearing proof-of-seam).
    labels = [n.label for n in flow.nodes]
    assert "label" in labels, f"interior label() must be traced; got {labels}"
    label_node = next(n for n in flow.nodes if n.label == "label")
    assert label_node.provenance == "observed", "interior node must be observed"

    # The return node binds the business fields the code actually produced.
    ret = next(n for n in flow.nodes if n.kind == "return")
    ret_names = {op.name for op in ret.operands}
    assert {"ok", "tag", "total"} <= ret_names, f"return must bind ok/tag/total; got {ret_names}"
    tag = next(op for op in ret.operands if op.name == "tag")
    assert tag.value == "pos" and tag.provenance == "observed"
    total = next(op for op in ret.operands if op.name == "total")
    assert total.value == 12, "total must be amount(10) + FEE(2) = 12, observed"
    ok = next(op for op in ret.operands if op.name == "ok")
    assert ok.value is True

    # Honesty: every operand provenance is valid.
    for op in flow.all_operands():
        assert op.provenance in ("observed", "declared", "unknown")


def test_classifier_uses_ts_vocab() -> None:
    """The Flow carries the TS-derived vocabulary → classifier_mode='vocab'."""
    flow = ts_flow(
        source_path=str(ORDER_TS),
        func="charge",
        kwargs={"o": {"id": "ord_2", "amount": 5, "currency": "EUR"}},
        vocab_fields=derive_ts_vocabulary([str(ORDER_TS)]),
    )
    assert flow.classifier_mode == "vocab"
    assert flow.vocab_size >= 6  # id, amount, currency, ok, tag, total


def test_thrown_error_is_observed() -> None:
    """When the typed function throws, the error is an observed node — no fake
    return node. Uses a simple-typed signature so both the regex fallback and the
    authoritative path lower it and the function actually runs + throws."""
    src = (
        "function deny(user: string): boolean {\n"
        '  if (!user) throw new Error("missing user");\n'
        "  return true;\n"
        "}\n"
        "module.exports = { deny };\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as tf:
        tf.write(src)
        path = tf.name
    try:
        flow = ts_flow(source_path=path, func="deny", kwargs={"user": ""})
    finally:
        os.unlink(path)
    err = next(
        (n for n in flow.nodes if n.kind == "other" and n.label == "thrown-error"),
        None,
    )
    assert err is not None, "thrown error must surface as an observed node"
    msg = next(op for op in err.operands if op.name == "message")
    assert "missing user" in str(msg.value)
    assert msg.provenance == "observed"
    # No fake return node when the function threw.
    assert not any(n.kind == "return" for n in flow.nodes)


# --------------------------------------------------------------------------- #
# Status line — mode transparency (spec §2d)
# --------------------------------------------------------------------------- #
def test_status_line_reports_adapter_mode_and_vocab() -> None:
    fields = derive_ts_vocabulary([str(ORDER_TS)])
    line = status_line(str(ORDER_TS), fields, "typescript")
    assert "adapter=typescript" in line
    assert "classifier_mode=vocab" in line
    assert f"vocab_count={len(fields)}" in line
    # Non-vocab line names the conservative fallback honestly.
    line_nv = status_line(str(ORDER_TS), set(), "regex")
    assert "classifier_mode=non_vocab" in line_nv
    assert "vocab_count=0" in line_nv


# --------------------------------------------------------------------------- #
# Authoritative path — requires the typescript npm module
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(
    not _has_typescript_module(),
    reason="typescript npm module not resolvable — authoritative tsc-transpile path unavailable",
)
def test_authoritative_tsc_transpile_handles_complex_types() -> None:
    """When the `typescript` module is available, tsc-transpile lowers types the
    regex fallback refuses (object return types, generics) — and the traced Flow
    still carries real observed interior nodes."""
    # Object-typed return + a generic-ish annotation the regex path refuses.
    src = (
        "interface Box { value: number }\n"
        "function unbox(b: Box): { value: number } { return { value: b.value } }\n"
        "function run(b: Box): { value: number } { return unbox(b) }\n"
        "module.exports = { run };\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as tf:
        tf.write(src)
        path = tf.name
    try:
        # Confirm the regex path refuses this (object return type) — so the test
        # genuinely exercises the authoritative path, not the fallback.
        _, strat_regex, _ = strip_types_best_effort(open(path).read(), file_name="x.ts")
        assert strat_regex != "typescript", "regex probe should not pick tsc"

        # With the typescript module resolvable via search_paths, the authoritative
        # path MUST be selected and lower the object return type.
        _, strat, ok = strip_types_best_effort(
            open(path).read(), file_name="x.ts", search_paths=_ts_search_paths(),
        )
        assert ok and strat == "typescript", (
            f"authoritative tsc path required; got strategy={strat!r}"
        )

        flow = ts_flow(
            source_path=path, func="run",
            kwargs={"b": {"value": 42}},
            search_paths=_ts_search_paths(),
        )
        labels = [n.label for n in flow.nodes]
        assert "unbox" in labels, f"interior unbox() must be traced via tsc; got {labels}"
        ret = next(n for n in flow.nodes if n.kind == "return")
        val = next(op for op in ret.operands if op.name == "value")
        assert val.value == 42 and val.provenance == "observed"
    finally:
        os.unlink(path)
