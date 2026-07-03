"""Flow canaries (spec §8.1) — the contract the new instrument MUST satisfy.

RED against the ``observe_flow`` stub until §8.2 (interior instrumentation) lands,
except ``test_fc5_guessed_operand_fails_the_build`` which is GREEN now: it pins the
provenance guard in the type system (principle #1 — a guessed operand cannot exist).
"""
from __future__ import annotations

import pytest

from dreplay.flow import Operand, observe_flow
from dreplay.types import ImplSpec

_MOD = "flow_canaries.scenarios"

_VERDICT_WORDS = ("bug", "risk", "vulnerab", "exceed", "broken", "wrong", "fail", "bad")


def _observe(func: str, kwargs: dict):
    return observe_flow(spec=ImplSpec(module=_MOD, func=func), kwargs=kwargs, mode="instant")


def _default_signature(flow) -> tuple:
    """The comparable shape of the default (business-meaningful) view."""
    return tuple(
        (n.kind, n.label, tuple((o.name, o.value, o.provenance) for o in n.operands))
        for n in flow.default_nodes()
    )


# FC1 — org created with owner=NULL appears as an observed business operand.
def test_fc1_owner_null_surfaced() -> None:
    flow = _observe("create_organization", {"name": "test"})
    default = flow.default_nodes()
    assert default, "FC1: default view must not be empty"
    found = any(
        op.provenance == "observed" and op.value is None and "owner" in op.name
        for n in default
        for op in n.operands
    )
    assert found, "FC1: org.owner=NULL must surface as an OBSERVED business operand"


# FC2 — a write path where the auth-check shows auth_state: not_executed.
def test_fc2_auth_not_executed_surfaced() -> None:
    flow = _observe("write_record", {"record": {"token": "x"}, "skip_auth": True})
    has_write = any(
        n.kind == "db_write" and n.business_meaningful for n in flow.default_nodes()
    )
    auth_not_run = any(
        "auth" in op.name
        and op.provenance == "observed"
        and op.value in ("not_executed", "not_observed", False)
        for n in flow.nodes
        for op in n.operands
    )
    assert has_write, "FC2: the write must appear as a business-meaningful node"
    assert auth_not_run, "FC2: auth_state=not_executed must surface as an observed fact"


# FC3 — timeout math as operands + an open question, NEVER a verdict.
def test_fc3_timeout_math_operands_no_verdict() -> None:
    flow = _observe("run_migration", {})
    ops = {op.name: op for n in flow.nodes for op in n.operands}
    assert "phases" in ops and ops["phases"].provenance == "observed"
    assert "concurrency" in ops and ops["concurrency"].provenance == "observed"
    assert "configured_timeout" in ops, "FC3: configured timeout must be an operand"
    sf = ops.get("serial_floor")
    assert sf and sf.provenance == "observed" and sf.derived_from, (
        "FC3: serial_floor must be DERIVED from observed operands (not estimated)"
    )
    questions = [n.open_question for n in flow.nodes if n.open_question]
    assert questions, "FC3: an open question must be generated"
    q = questions[0].lower()
    assert "intended" in q, "FC3: the question must end in 'intended?'"
    for bad in _VERDICT_WORDS:
        assert bad not in q, f"FC3: open question must not contain verdict word {bad!r}: {questions[0]}"


# FC4 — same code + same input ⇒ identical default flow (reproducible, principle #4).
def test_fc4_default_flow_is_deterministic() -> None:
    f1 = _observe("compute_a", {"x": 1})
    f2 = _observe("compute_a", {"x": 1})
    assert _default_signature(f1) == _default_signature(f2), (
        "FC4: same code + same input must yield an identical default flow"
    )


# FC4b — a no-op refactor (extra plumbing, same behavior): the plumbing stays
# collapsed and the observable business output is identical. (Node *labels* may
# differ — different functions — that is not the contract.)
def test_fc4_noop_refactor_keeps_default_flow() -> None:
    fa = _observe("compute_a", {"x": 1})
    fb = _observe("compute_b", {"x": 1})
    assert not any("inc" in n.label.lower() for n in fb.default_nodes()), (
        "FC4: the refactor's plumbing (_inc) must stay collapsed, not become a business node"
    )

    def _ret_v(flow) -> int | None:
        for n in flow.default_nodes():
            if n.kind == "return":
                return next((o.value for o in n.operands if o.name == "v"), None)
        return None

    assert _ret_v(fa) == _ret_v(fb) == 2, "FC4: a no-op refactor must keep the same business output"


# FC5 — a guessed operand fails the build (principle #1, enforced in the type system).
# This one is GREEN now; it pins the guard before the engine exists.
def test_fc5_guessed_operand_fails_the_build() -> None:
    with pytest.raises(ValueError):
        Operand(name="x", value=42, provenance="guessed")


# FC5b — every shown operand carries a valid observed/declared/unknown provenance.
def test_fc5_every_shown_operand_has_valid_provenance() -> None:
    flow = _observe("create_organization", {"name": "test"})
    for op in flow.all_operands():
        assert op.provenance in ("observed", "declared", "unknown"), (
            f"FC5: operand {op.name!r} has invalid provenance {op.provenance!r}"
        )


# FC6 — conservative non-vocab fallback: without importable models, a non-dominant
# field (entitlement) collapses to avoid the noise explosion the denylist caused on
# no-models repos (pycasbin: 140-node default view). The vocab-mode test (entitlement
# shows WHEN a model declares it) is in tests/test_vocabulary.py.
def test_fc6_non_dominant_field_collapses_without_models() -> None:
    flow = _observe("grant", {"record": {"entitlement": "premium"}})
    assert not any(n.label == "_check_entitlement" for n in flow.default_nodes()), (
        "FC6: without models, non-dominant 'entitlement' must collapse (conservative "
        "fallback — the pycasbin explosion prevention)"
    )


# FC7 — noise control: a conversion verb (_to_dict) that binds business-shaped fields
# (amount/status) still COLLAPSES under the inversion (plumbing label wins).
def test_fc7_plumbing_label_collapses_even_when_binding() -> None:
    flow = _observe("serialize_order", {"order": {"amount": 10, "status": "ok"}})
    assert not any(n.label == "_to_dict" for n in flow.default_nodes()), (
        "FC7: _to_dict (conversion verb) must collapse even though it binds amount/status"
    )
    ret = [n for n in flow.default_nodes() if n.kind == "return"]
    assert ret and any(o.name == "amount" for o in ret[0].operands), \
        "FC7: the return node must still surface the bound amount"


# FC8 — rename-stability: a renamed business helper (_tally -> _sum) still shows
# (binds the same business fields). Pins that a rename doesn't silently collapse.
def test_fc8_rename_preserves_business_default_view() -> None:
    fa = _observe("checkout_a", {"order": {"amount": 10, "currency": "USD"}})
    fb = _observe("checkout_b", {"order": {"amount": 10, "currency": "USD"}})
    assert any(o.name == "amount" for n in fa.default_nodes() for o in n.operands), (
        "FC8: _tally binding amount must show"
    )
    assert any(o.name == "amount" for n in fb.default_nodes() for o in n.operands), (
        "FC8: renamed _sum binding amount must also show (rename-stable)"
    )
