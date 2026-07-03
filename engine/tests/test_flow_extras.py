"""Pins the closed limitations: datetime.now() freezing + business-field widening."""
from __future__ import annotations

import os

from dreplay.flow import observe_flow
from dreplay.instrument import run_flow
from dreplay.types import ImplSpec, Policy

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_datetime_now_is_frozen_when_clock_set() -> None:
    clock = 1234567890.0
    flow = run_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="now_ts"),
        kwargs={}, mode="instant", policy=Policy(clock=clock), python_path=[_REPO],
    )
    ret = next(n for n in flow.nodes if n.kind == "return")
    t = next(o.value for o in ret.operands if o.name == "t")
    assert t == clock, f"datetime.utcnow() must be frozen to the injected clock; got {t}"


def test_business_fields_is_now_a_noop_under_inversion() -> None:
    # Without importable models, the classifier uses the conservative dominant-fields
    # allowlist (avoids the pycasbin noise explosion). _audit binds 'entitlement' which
    # is NOT dominant → collapses. The vocab-mode test (entitlement shows WITH a model)
    # is in tests/test_vocabulary.py.
    kwargs = {"record": {"entitlement": "admin"}}
    flow = observe_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="process"),
        kwargs=kwargs, python_path=[_REPO],
    )
    assert not [n for n in flow.default_nodes() if n.label == "_audit"], (
        "without models, non-dominant 'entitlement' collapses (conservative fallback)"
    )
