"""Traced Node adapter — real interior nodes via AST-rewrite (closes the §8.8 gap)."""
from __future__ import annotations

import os
import shutil
import tempfile

import pytest

from dreplay.adapter.node_flow import node_flow
from dreplay.js_trace import available as js_trace_available

_NODE = shutil.which("node")


def _js(src: str) -> str:
    d = tempfile.mkdtemp()
    p = os.path.join(d, "m.js")
    with open(p, "w") as fh:
        fh.write(src)
    return p


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_interior_calls() -> None:
    p = _js(
        'function tag(x){ return x>0?"pos":"neg" }\n'
        'function classify(x){ return {ok: x>0, tag: tag(x)} }\n'
        "module.exports = { classify }\n"
    )
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    labels = [n.label for n in flow.nodes]
    assert "tag" in labels, f"interior tag() call must be traced; got {labels}"
    tag_node = next(n for n in flow.nodes if n.label == "tag")
    assert tag_node.provenance == "observed", "interior node must be observed, not synthesized"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands), "return must bind tag='pos'"
    assert any(o.name == "ok" and o.value is True for o in ret.operands), "return must bind ok=true"


@pytest.mark.skipif(not _NODE, reason="node not on PATH")
def test_node_flow_falls_back_when_not_rewriteable() -> None:
    # arrow-only export, no top-level FunctionDeclaration → rewrite yields nothing →
    # honest endpoints-only fallback (the interior-unobservable note), never a fake.
    p = _js("module.exports = { classify: (x) => ({ok: x>0}) }\n")
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    assert any(n.label == "interior-unobservable" for n in flow.nodes), (
        "unrewriteable source must fall back to endpoints-only honestly"
    )
    ret = next((n for n in flow.nodes if n.kind == "return"), None)
    assert ret and any(o.name == "ok" and o.value is True for o in ret.operands)


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_arrow_helpers() -> None:
    # An expression-body arrow helper + a FunctionDeclaration entrypoint — both
    # top-level, both rewriteable. The arrow must be traced as an interior node.
    p = _js(
        'const label = (x) => x>0?"pos":"neg"\n'
        'function classify(x){ return {ok: x>0, tag: label(x)} }\n'
        "module.exports = { classify }\n"
    )
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    labels = [n.label for n in flow.nodes]
    assert "label" in labels, f"arrow helper must be traced; got {labels}"
    label_node = next(n for n in flow.nodes if n.label == "label")
    assert label_node.provenance == "observed"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands)


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_async_functions() -> None:
    # An async entrypoint awaiting an async helper — both must be traced. Body-splice
    # keeps `async` intact; the await-IIFE resolves the helper before __dt_exit.
    p = _js(
        'async function fetchLabel(x){ return x>0?"pos":"neg" }\n'
        'async function classify(x){ return {ok: x>0, tag: await fetchLabel(x)} }\n'
        "module.exports = { classify }\n"
    )
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    labels = [n.label for n in flow.nodes]
    assert "fetchLabel" in labels, f"async helper must be traced; got {labels}"
    fl = next(n for n in flow.nodes if n.label == "fetchLabel")
    assert fl.provenance == "observed"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands), (
        "async entrypoint must resolve and bind tag='pos'"
    )


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_async_arrow_helper() -> None:
    # An expression-body ASYNC arrow helper — both async + arrow edge cases at once.
    p = _js(
        'const label = async (x) => x>0?"pos":"neg"\n'
        'async function classify(x){ return {ok: x>0, tag: await label(x)} }\n'
        "module.exports = { classify }\n"
    )
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    labels = [n.label for n in flow.nodes]
    assert "label" in labels, f"async arrow helper must be traced; got {labels}"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands)


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_nested_helpers() -> None:
    # A helper DECLARED INSIDE the entrypoint — iterative reparse rewrites nested
    # functions (top-level-only could not).
    p = _js(
        "function classify(x){\n"
        "  function tag(v){ return v>0?\"pos\":\"neg\" }\n"
        "  return {ok: x>0, tag: tag(x)}\n"
        "}\n"
        "module.exports = { classify }\n"
    )
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    labels = [n.label for n in flow.nodes]
    assert "tag" in labels, f"nested helper must be traced; got {labels}"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands)


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_destructured_params() -> None:
    # A function with a DESTRUCTURED param — the IIFE replicates the param pattern so
    # the binding survives. (Args mode + replicated params.)
    p = _js(
        "function total({amount, fee}){ return amount + fee }\n"
        "function run(p){ return {sum: total(p)} }\n"
        "module.exports = { run }\n"
    )
    flow = node_flow(module_path=p, func="run", kwargs={"p": {"amount": 10, "fee": 2}})
    labels = [n.label for n in flow.nodes]
    assert "total" in labels, f"destructured-param helper must be traced; got {labels}"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "sum" and o.value == 12 for o in ret.operands), (
        "destructured binding must resolve correctly (amount+fee=12), not NaN"
    )


@pytest.mark.skipif(not _NODE or not js_trace_available(),
                    reason="node and esprima required for AST-traced interior nodes")
def test_node_flow_traces_object_methods() -> None:
    # An object-literal METHOD called as svc.label(x) — this-binding comes from the
    # call site, so interior method calls trace correctly.
    p = _js(
        "function classify(x){\n"
        "  const svc = { label(v){ return v>0?\"pos\":\"neg\" } };\n"
        "  return {ok: x>0, tag: svc.label(x)};\n"
        "}\n"
        "module.exports = { classify }\n"
    )
    flow = node_flow(module_path=p, func="classify", kwargs={"x": 5})
    labels = [n.label for n in flow.nodes]
    assert "label" in labels, f"object method must be traced; got {labels}"
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert any(o.name == "tag" and o.value == "pos" for o in ret.operands)
