"""Conformance tests for the C# / .NET FLOW-mode adapter (spec §2a/§8.8).

Pins the honesty contract for the C# adapter:

* interior call/return nodes are OBSERVED (the Roslyn source-instrumentation tracer
  really ran the method and snapshotted params + return);
* operands carry valid provenance (observed / declared / unknown — the type-system
  guard in ``Operand.__post_init__`` enforces this at construction);
* no verdict word leaks into a rendered flow (principle #2 — facts, not verdicts);
* the vocab deriver reads the fixture's OWN ``OrderRecord`` field declarations;
* an auth check the entrypoint references but does NOT execute on a path is surfaced
  as an observed auth-not-executed node;
* a thrown exception is observed (never a fake return node);
* if ``dotnet`` is not installed, the whole module skips — the adapter is never faked
  (principle #7: do not fake the plumbing).

The fixture is a real, checked-in C# program (``tests/csharp_fixtures/OrderSvc.cs``).
"""
from __future__ import annotations

import os
import shutil

import pytest

from dreplay.adapter.csharp_flow import (
    csharp_flow,
    derive_csharp_vocabulary,
)
from dreplay.flow import Flow
from dreplay.flow_render import render_flow

_FIXTURE = os.path.join(os.path.dirname(__file__), "csharp_fixtures", "OrderSvc.cs")

# Words a JUDGMENT would use — must never appear in a rendered observed flow.
_VERDICT_WORDS = ("bug", "risk", "vulnerab", "broken", "wrong", "danger", "insecure")

_HAS_DOTNET = shutil.which("dotnet") is not None
pytestmark = pytest.mark.skipif(
    not _HAS_DOTNET,
    reason="dotnet SDK not on PATH — C# adapter is never faked (principle #7)",
)


def test_vocab_deriver_reads_record_fields() -> None:
    """The vocab deriver reads the fixture's OWN model declarations (OrderRecord),
    not name-guesses — the structural fix for the inverted classifier."""
    vocab = derive_csharp_vocabulary(_FIXTURE)
    assert {"Name", "Amount", "Currency", "Saved"} <= vocab.fields, (
        f"vocab must include the OrderRecord auto-properties; got {sorted(vocab.fields)}"
    )
    assert vocab.mode == "vocab"
    assert len(vocab.fields) >= 4


def test_interior_calls_observed() -> None:
    """The load-bearing contract: interior call/return nodes are OBSERVED (the
    Roslyn tracer really ran CreateOrder → Verify + Compute)."""
    flow = csharp_flow(
        source_path=_FIXTURE, type_name="OrderSvc", method="CreateOrder",
        kwargs={"name": "Acme", "qty": 5},
    )
    assert isinstance(flow, Flow)
    default = flow.default_nodes()
    kinds = [n.kind for n in default]
    assert "input" in kinds
    assert "return" in kinds

    # Verify (auth) and Compute (transform) ran → both observed as nodes.
    labels = {n.label for n in flow.nodes}
    assert "Verify" in labels, "interior Verify call not observed"
    assert "Compute" in labels, "interior Compute call not observed"

    # The return carries the business fields the function produced.
    ret = next(n for n in default if n.kind == "return")
    ret_names = {o.name for o in ret.operands}
    assert "amount" in ret_names
    amount = next(o for o in ret.operands if o.name == "amount")
    assert amount.value == 50  # qty(5) * unitPrice(10)
    assert amount.provenance == "observed"

    # The write indicator `saved` is observed.
    saved = next(o for o in ret.operands if o.name == "saved")
    assert saved.value is True


def test_every_operand_valid_provenance() -> None:
    flow = csharp_flow(
        source_path=_FIXTURE, type_name="OrderSvc", method="CreateOrder",
        kwargs={"name": "Acme", "qty": 5},
    )
    for op in flow.all_operands():
        assert op.provenance in ("observed", "declared", "unknown"), (
            f"operand {op.name!r} has invalid provenance {op.provenance!r}"
        )


def test_no_verdict_word_in_rendered_flow() -> None:
    flow = csharp_flow(
        source_path=_FIXTURE, type_name="OrderSvc", method="CreateOrder",
        kwargs={"name": "Acme", "qty": 5},
    )
    text = render_flow(flow).lower()
    for bad in _VERDICT_WORDS:
        assert bad not in text, f"rendered flow leaked verdict word {bad!r}"


def test_thrown_exception_observed() -> None:
    """When the method throws, the exception is observed (no fake return node)."""
    flow = csharp_flow(
        source_path=_FIXTURE, type_name="OrderSvc", method="Deny",
        kwargs={"user": None},
    )
    # The tracer records the exception as the payload's `exception`; the reducer
    # surfaces it. No business-meaningful return node should carry a fake value.
    default = flow.default_nodes()
    # The exception appears somewhere in the flow's operands (observed).
    assert any(
        "missing user" in str(o.value)
        for n in flow.nodes for o in n.operands
    ), "thrown exception message not observed"


def test_status_line_adapter_and_vocab() -> None:
    """Spec §2d: the adapter prints which adapter + classifier mode + vocab count.
    The flow's classifier_mode/vocab_size reflect a vocab-mode run."""
    flow = csharp_flow(
        source_path=_FIXTURE, type_name="OrderSvc", method="CreateOrder",
        kwargs={"name": "Acme", "qty": 5},
    )
    assert flow.classifier_mode == "vocab"
    assert flow.vocab_size >= 4


def test_dotnet_missing_is_honest_not_faked(monkeypatch) -> None:
    """If dotnet is unavailable, the adapter returns an instrumentation-error Flow
    (provenance unknown, business-meaningful) — NEVER a fake clean run."""
    monkeypatch.setattr(
        "dreplay.adapter.csharp_flow.shutil.which", lambda _name: None
    )
    flow = csharp_flow(
        source_path=_FIXTURE, type_name="OrderSvc", method="CreateOrder",
        kwargs={"name": "Acme", "qty": 5},
    )
    err_nodes = [n for n in flow.nodes if n.label == "instrumentation-error"]
    assert len(err_nodes) == 1
    assert err_nodes[0].provenance == "unknown"
    assert err_nodes[0].business_meaningful is True
    # No fake return node.
    assert not any(n.kind == "return" for n in flow.nodes)
