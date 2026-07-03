"""Regressions for defects found by the multi-repo ultracode probe (2026-07-02).

Each test is a minimal, dependency-free reproduction of a verified finding, so
the real-repo behavior is pinned without cloning anything. Grouped by cluster.
"""
from __future__ import annotations

import json
import os

import pytest

from dreplay import containment, flow_cli
from dreplay.flow import observe_flow
from dreplay.flow_fuzz import fuzz_flow, render_fuzz, to_fuzz_json
from dreplay.instrument import _is_tagged_scalar
from dreplay.types import ImplSpec

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LEVEL = containment.detect().level
_KERNEL = _LEVEL in ("seccomp", "kernel_netns")


# ---- Cluster A: worker crash on non-JSON-serializable module constants --------
def test_set_constant_does_not_crash_worker(tmp_path):
    """inflection/boltons: a bare set/bytes UPPER constant made _ast_read yield a
    non-JSON value that truncated the worker's protocol document mid-stream →
    instrumentation-error blaming the user. The emit must be total now."""
    (tmp_path / "setmod.py").write_text(
        "UNCOUNTABLE = {'a', 'b'}\n"
        "_EMPTY = b'\\x00'\n"
        "def f(word: str) -> dict:\n"
        "    return {'word': word, 'plural': word + 's'}\n"
    )
    flow = observe_flow(spec=ImplSpec(module="setmod", func="f"),
                        kwargs={"word": "cat"}, python_path=[str(tmp_path)])
    labels = [n.label for n in flow.nodes]
    assert "instrumentation-error" not in labels, "set/bytes constant must not crash the worker"
    ret = next(n for n in flow.nodes if n.kind == "return")
    vals = {o.name: o.value for o in ret.operands}
    assert vals.get("plural") == "cats"


# ---- Cluster B: entrypoint typo is a refuse, not observed target behavior -----
def test_typo_entrypoint_is_instrumentation_error_not_thrown_error(tmp_path):
    (tmp_path / "mod.py").write_text("def real(x: int) -> dict:\n    return {'x': x}\n")
    flow = observe_flow(spec=ImplSpec(module="mod", func="nosuchfunc"),
                        kwargs={"x": 1}, python_path=[str(tmp_path)])
    labels = [n.label for n in flow.nodes]
    assert "instrumentation-error" in labels, "unresolved entrypoint must be a refuse"
    assert "thrown-error" not in labels, "a config typo must NOT be framed as observed target raise"
    err = next(n for n in flow.nodes if n.label == "instrumentation-error")
    # honest, actionable question — does not blame the (valid) target code
    assert "did not resolve" in (err.open_question or "")


def test_unimportable_module_is_refuse_with_honest_reason(tmp_path):
    (tmp_path / "broken.py").write_text("import a_module_that_does_not_exist_xyz\n")
    flow = observe_flow(spec=ImplSpec(module="broken", func="f"),
                        kwargs={}, python_path=[str(tmp_path)])
    err = next((n for n in flow.nodes if n.label == "instrumentation-error"), None)
    assert err is not None
    assert flow.fallback_reason and "not observed" in flow.fallback_reason


def test_genuine_target_raise_is_still_thrown_error(tmp_path):
    """The split must NOT swallow a real raise from the resolved function."""
    (tmp_path / "boom.py").write_text("def boom(x: int) -> dict:\n    raise ValueError('real')\n")
    flow = observe_flow(spec=ImplSpec(module="boom", func="boom"),
                        kwargs={"x": 1}, python_path=[str(tmp_path)])
    labels = [n.label for n in flow.nodes]
    assert "thrown-error" in labels, "a real raise from resolved code stays observed"
    assert "instrumentation-error" not in labels


# ---- Cluster C: src-layout parity + no-op diff refuse -------------------------
def test_src_layout_imports_without_pointing_at_src(tmp_path):
    """humanize/werkzeug: package under <repo>/src must import from --repo <repo>."""
    src = tmp_path / "src" / "pkg"
    src.mkdir(parents=True)
    (src / "__init__.py").write_text("")
    (src / "mod.py").write_text("def f(x: int) -> dict:\n    return {'x': x}\n")
    flow = observe_flow(spec=ImplSpec(module="pkg.mod", func="f"),
                        kwargs={"x": 2}, python_path=[str(tmp_path)])
    assert "instrumentation-error" not in [n.label for n in flow.nodes]
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert {o.name: o.value for o in ret.operands}.get("x") == 2


# ---- Cluster D: fuzz honesty ---------------------------------------------------
def test_all_raising_fuzz_never_claims_stable(tmp_path):
    """python-slugify/more-itertools: 100% raising variants exited 0 'stable'."""
    (tmp_path / "raiser.py").write_text(
        "def always(x: int) -> dict:\n    raise ValueError('nope ' + str(x))\n")
    schema = {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]}
    report = fuzz_flow(spec=ImplSpec(module="raiser", func="always"),
                       schema=schema, variant_count=5, seed=0,
                       python_path=[str(tmp_path)], egress="full")
    out = render_fuzz(report)
    assert "stable" not in out.lower(), "an all-raising pass must never say 'stable'"
    assert "all" in out.lower() and "raised" in out.lower()
    # CLI exit must surface it for review (1), not report clean (0)
    sfile = tmp_path / "s.json"
    sfile.write_text(json.dumps(schema))
    rc = flow_cli.main(["--entrypoint", "raiser.always", "--repo", str(tmp_path),
                        "--mode", "fuzz", "--allow-egress", "--schema", str(sfile),
                        "--variants", "5"])
    assert rc == 1, "all-raising fuzz must exit 1 (surfaced), never 0 (stable)"


def test_fuzz_raises_carry_message_and_reproducing_input(tmp_path):
    (tmp_path / "r.py").write_text(
        "def f(x: int) -> dict:\n"
        "    if x % 2:\n        raise KeyError('odd ' + str(x))\n"
        "    return {'x': x}\n")
    schema = {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]}
    report = fuzz_flow(spec=ImplSpec(module="r", func="f"), schema=schema,
                       variant_count=8, seed=0, python_path=[str(tmp_path)], egress="full")
    doc = json.loads(to_fuzz_json(report))
    assert doc["raises"], "raises must be reported with detail, not just a count"
    for r in doc["raises"]:
        assert r["type"] == "KeyError"
        assert "reproduce_with" in r and isinstance(r["reproduce_with"], dict)


def test_fuzz_reproduce_strings_are_valid_json(tmp_path):
    """The tool's own printed repro must be paste-able into --input (was Python repr)."""
    report = fuzz_flow(spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
                       schema={"type": "object", "properties": {"token": {"type": "string"}},
                               "required": ["token"]},
                       variant_count=8, seed=0, python_path=[_REPO], egress="full")
    out = render_fuzz(report)
    for line in out.splitlines():
        if "<- reproduce:" in line:
            payload = line.split("<- reproduce:", 1)[1].strip()
            json.loads(payload)  # must parse as JSON, not raise


def test_fuzz_report_carries_classifier_transparency(tmp_path):
    report = fuzz_flow(spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
                       schema={"type": "object", "properties": {"token": {"type": "string"}},
                               "required": ["token"]},
                       variant_count=6, seed=0, python_path=[_REPO], egress="full")
    assert "classifier:" in render_fuzz(report)
    doc = json.loads(to_fuzz_json(report))
    assert "classifier_mode" in doc and "vocab_size" in doc


def test_fuzz_exception_message_variation_is_not_a_varied_operand(tmp_path):
    """humanize: a raise whose message embeds the random input must not be keyed
    as a 'varied business operand' — the raise is captured separately."""
    (tmp_path / "m.py").write_text(
        "def f(x: int) -> dict:\n    raise ValueError('bad value ' + str(x))\n")
    schema = {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]}
    report = fuzz_flow(spec=ImplSpec(module="m", func="f"), schema=schema,
                       variant_count=6, seed=0, python_path=[str(tmp_path)], egress="full")
    for (kind, label, opname) in report.varied:
        assert not (kind == "other" and label == "thrown-error"), \
            "thrown-error message must not be surfaced as a varied operand"


# ---- Cluster E: iterator/opaque return not dropped ----------------------------
def test_is_tagged_scalar_detects_canonical_encodings():
    assert _is_tagged_scalar({"__repr__": "<generator>"})
    assert _is_tagged_scalar({"__set__": [1, 2]})
    assert _is_tagged_scalar({"__iso__": "2020-01-01"})
    assert not _is_tagged_scalar({"owner": None, "name": "x"})
    assert not _is_tagged_scalar({"__repr__": "x", "other": 1})
    assert not _is_tagged_scalar({})


def test_generator_return_is_surfaced_not_dropped(tmp_path):
    """more-itertools: a lazy-iterator return canonicalizes to {'__repr__': ...};
    the __-key filter silently produced an empty return node."""
    (tmp_path / "genmod.py").write_text(
        "def chunked(n: int):\n    return (i for i in range(n))\n")
    flow = observe_flow(spec=ImplSpec(module="genmod", func="chunked"),
                        kwargs={"n": 3}, python_path=[str(tmp_path)])
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert ret.operands, "a generator return must not be dropped to an empty node"
    assert "<return>" in {o.name for o in ret.operands}
    assert "generator" in str(ret.operands[0].value)


def test_dict_business_object_return_still_expands(tmp_path):
    """The tagged-scalar branch must NOT swallow genuine field dicts."""
    (tmp_path / "d.py").write_text(
        "def make(name: str) -> dict:\n    return {'name': name, 'status': 'active'}\n")
    flow = observe_flow(spec=ImplSpec(module="d", func="make"),
                        kwargs={"name": "Acme"}, python_path=[str(tmp_path)])
    ret = next(n for n in flow.nodes if n.kind == "return")
    names = {o.name for o in ret.operands}
    assert "name" in names and "status" in names
