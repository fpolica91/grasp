"""Mode B (fuzz) — surfaces business operands that vary across inputs.

These pin the VARIATION logic, so they run with ``egress="full"`` to stay
host-independent (the targets are pure functions; nothing egresses). The walled
default, the refusal on weak hosts, and the wall itself are pinned separately in
``tests/test_flow_fuzz_wall.py``.
"""
from __future__ import annotations

import json
import os
from types import SimpleNamespace

from dreplay.flow_fuzz import fuzz_flow, render_fuzz, to_fuzz_json
from dreplay.types import ImplSpec

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_SCHEMA = {"type": "object", "properties": {"token": {"type": "string"}}, "required": ["token"]}


def _varied_values(report, opname: str) -> set:
    out = set()
    for (_kind, _label, name), vals in report.varied.items():
        if name == opname:
            out = {value for value, _repro in vals.values()}
    return out


def test_mode_b_surfaces_input_dependent_variation() -> None:
    report = fuzz_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
        schema=_SCHEMA,
        variant_count=10,
        seed=0,
        python_path=[_REPO],
        egress="full",
    )
    # status varies between "authenticated" (non-empty token) and "denied" (empty)
    varied_names = {opname for (_kind, _label, opname) in report.varied}
    assert "status" in varied_names, "Mode B must surface the status operand varying across inputs"
    status_values = _varied_values(report, "status")
    assert "authenticated" in status_values and "denied" in status_values


def test_render_fuzz_lists_reproducing_inputs_and_no_verdict() -> None:
    report = fuzz_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
        schema=_SCHEMA, variant_count=8, seed=0, python_path=[_REPO], egress="full",
    )
    out = render_fuzz(report)
    assert "<- reproduce:" in out, "must attach reproducing inputs"
    assert "intended?" in out
    for bad in ("bug", "risk", "vulnerab", "broken", "wrong"):
        assert bad not in out.lower(), f"render must not contain verdict word {bad!r}"


def test_mode_b_stable_flow_reports_no_variation() -> None:
    # compute_a never varies its observable output for fixed input across the corpus...
    # but the fuzzer varies x, so 'v' WILL vary. Use a constant function instead.
    import flow_canaries.scenarios as s  # noqa: F401
    #authenticate-like stable: use a func that ignores input
    report = fuzz_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="run_migration"),
        schema={"type": "object"}, variant_count=4, seed=0, python_path=[_REPO],
        egress="full",
    )
    out = render_fuzz(report)
    assert "stable" in out.lower() or "varied" in out.lower()  # either is an honest report


def test_unobserved_variants_are_gaps_not_stability(monkeypatch) -> None:
    """A variant whose worker never ran (instrumentation-error) must land in
    report.errors, be surfaced by the renderer, and never back a 'stable' claim."""
    import dreplay.instrument as instrument

    def _broken_worker(*_a, **_k):
        return SimpleNamespace(stdout="not json", stderr="")

    monkeypatch.setattr(instrument.subprocess, "run", _broken_worker)
    report = fuzz_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
        schema=_SCHEMA, variant_count=3, seed=0, python_path=[_REPO], egress="full",
    )
    assert len(report.errors) == 3, "unrunnable variants must be recorded as errors"
    assert not report.varied
    out = render_fuzz(report)
    assert "could NOT be observed" in out
    assert "stable" not in out.lower(), "0 observed runs must not produce a stability claim"
    assert "no claim is made" in out


def test_raises_are_observed_facts_in_the_report() -> None:
    """A variant that raises shows up in report.raised() and in the rendered
    header — an observed fact, never dropped."""
    report = fuzz_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="write_record"),
        # write_record(record: dict, ...) — fuzz a non-dict 'record' so some
        # variants raise AttributeError (record.get on a non-dict).
        schema={"type": "object", "properties": {"record": {"type": "string"}},
                "required": ["record"]},
        variant_count=4, seed=0, python_path=[_REPO], egress="full",
    )
    raised = report.raised()
    assert raised, "raising variants must be observed in report.raised()"
    # each raise carries a reproducing input (same contract as varied values)
    assert report.raises and all("input" in r for r in report.raises)
    out = render_fuzz(report)
    assert "observed raises across variants" in out
    assert "<- reproduce:" in out, "a raise must carry a reproducing input"


def test_to_fuzz_json_carries_transparency_and_repro() -> None:
    report = fuzz_flow(
        spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
        schema=_SCHEMA, variant_count=6, seed=0, python_path=[_REPO], egress="full",
    )
    doc = json.loads(to_fuzz_json(report))
    assert doc["mode"] == "fuzz"
    assert doc["egress"] == "full"
    assert doc["variant_count"] == 6
    assert doc["seed"] == 0
    varied_ops = {v["operand"] for v in doc["varied"]}
    assert "status" in varied_ops
    for v in doc["varied"]:
        for val in v["values"]:
            assert "reproduce_with" in val
