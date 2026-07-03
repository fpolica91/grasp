"""Global conformance: across EVERY canary scenario the instrument must emit NO
verdict word and every operand must carry a valid provenance. This pins the
product's whole moat (principle #1 observed-never-guessed, #2 facts-not-verdicts)
on real flows, not just per-canary."""
from __future__ import annotations

import os

from dreplay.flow import observe_flow
from dreplay.flow_render import render_flow
from dreplay.types import ImplSpec

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Words a JUDGMENT would use. (excluded: 'error'/'exceed'/'fail' can appear in
# legitimate observed-fact labels/messages, e.g. a thrown-error node.)
_VERDICT_WORDS = ("bug", "risk", "vulnerab", "broken", "wrong", "danger", "insecure")

_CASES = [
    ("create_organization", {"name": "Acme"}),
    ("write_record", {"record": {"token": "x"}, "skip_auth": True}),
    ("run_migration", {}),
    ("compute_a", {"x": 1}),
    ("authenticate", {"token": "tok"}),
]


def test_no_verdict_word_in_any_rendered_flow() -> None:
    for func, kwargs in _CASES:
        flow = observe_flow(
            spec=ImplSpec(module="flow_canaries.scenarios", func=func),
            kwargs=kwargs, python_path=[_REPO],
        )
        text = render_flow(flow).lower()
        for bad in _VERDICT_WORDS:
            assert bad not in text, f"{func}: rendered flow leaked verdict word {bad!r}"


def test_every_operand_has_valid_provenance() -> None:
    for func, kwargs in _CASES:
        flow = observe_flow(
            spec=ImplSpec(module="flow_canaries.scenarios", func=func),
            kwargs=kwargs, python_path=[_REPO],
        )
        for op in flow.all_operands():
            assert op.provenance in ("observed", "declared", "unknown"), (
                f"{func}: operand {op.name!r} has invalid provenance {op.provenance!r}"
            )
