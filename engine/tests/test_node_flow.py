"""Tests for the Node.js FLOW-mode adapter (proof-of-seam, spec §8.8).

Pins the honesty contract:

* endpoints (input/return, input/thrown-error, input/external_call) are OBSERVED;
* NO interior node is synthesized — a labelled ``interior-unobservable`` note
  (provenance ``unknown``, NOT business-meaningful) records why;
* every operand provenance is one of observed/declared/unknown (the type-system
  guard in ``Operand.__post_init__`` enforces this at construction).

If ``node`` is not on PATH, the whole module skips — the adapter is a
proof-of-seam and is never faked (principle #7).
"""
from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

import pytest

from dreplay.adapter.node_flow import node_flow
from dreplay.flow import Flow, Node

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node not on PATH",
)


def _write_module(tmp_path: Path, body: str) -> Path:
    mod = tmp_path / "lib.js"
    mod.write_text(textwrap.dedent(body))
    return mod


def test_return_endpoint_observed(tmp_path):
    mod = _write_module(tmp_path, """\
        module.exports = function classify(x) {
          return { ok: x > 0, tag: x > 0 ? "pos" : "neg" };
        };
    """)
    flow = node_flow(module_path=str(mod), func="classify", kwargs={"x": 5})

    assert isinstance(flow, Flow)
    default = flow.default_nodes()
    kinds = [n.kind for n in default]
    # input + return are business-meaningful; the interior-unobservable note is NOT.
    assert "input" in kinds
    assert "return" in kinds
    assert "interior-unobservable" not in [n.label for n in default]

    ret = next(n for n in default if n.kind == "return")
    names = {o.name for o in ret.operands}
    assert "ok" in names and "tag" in names  # business fields observed
    ok = next(o for o in ret.operands if o.name == "ok")
    assert ok.value is True and ok.provenance == "observed"

    # Honesty: every operand provenance is valid (the type guard already enforces
    # this, but assert it explicitly for the proof-of-seam).
    for op in flow.all_operands():
        assert op.provenance in ("observed", "declared", "unknown")


def test_thrown_error_endpoint_observed(tmp_path):
    mod = _write_module(tmp_path, """\
        module.exports = function deny(user) {
          if (!user) throw new Error("missing user");
          return { ok: true };
        };
    """)
    flow = node_flow(module_path=str(mod), func="deny", kwargs={"user": None})

    default = flow.default_nodes()
    err = next(n for n in default if n.kind == "other" and n.label == "thrown-error")
    msg = next(o for o in err.operands if o.name == "message")
    assert "missing user" in str(msg.value)
    assert msg.provenance == "observed"
    # No fake return node when the function threw.
    assert not any(n.kind == "return" for n in default)


def test_external_call_observed(tmp_path):
    # fetch() is monkeypatched to record (no real network) — but the worker's
    # recorder returns undefined and does not throw, so the function continues.
    mod = _write_module(tmp_path, """\
        module.exports = async function ping(host) {
          try { await fetch("https://" + host + "/charge", { method: "POST", body: '{"amount":5}' }); } catch (e) {}
          return { ok: true };
        };
    """)
    flow = node_flow(module_path=str(mod), func="ping", kwargs={"host": "api.example.com"})

    default = flow.default_nodes()
    ext = next(n for n in default if n.kind == "external_call")
    host = next(o for o in ext.operands if o.name == "host")
    method = next(o for o in ext.operands if o.name == "method")
    assert "api.example.com" in str(host.value)
    assert method.value == "POST"
    assert host.provenance == "observed"


def test_no_interior_node_synthesized(tmp_path):
    """The load-bearing honesty rule: no interior node is faked. The only
    interior-shaped node is the labelled, non-business-meaningful note."""
    mod = _write_module(tmp_path, """\
        module.exports = function flow(x) {
          var doubled = x * 2;     // interior — UNOBSERVABLE from JS
          var tagged = doubled > 0 ? "big" : "small";  // interior — UNOBSERVABLE
          return { value: tagged };
        };
    """)
    flow = node_flow(module_path=str(mod), func="flow", kwargs={"x": 3})

    # No interior transform/controller/validation node is synthesized.
    interior_kinds = {"controller", "auth_check", "validation", "db_write",
                      "db_read", "transform"}
    for n in flow.nodes:
        assert n.kind not in interior_kinds, f"interior node {n.kind!r} synthesized"

    # The gap IS surfaced — as a labelled, non-default note.
    notes = [n for n in flow.nodes if n.label == "interior-unobservable"]
    assert len(notes) == 1
    note = notes[0]
    assert note.business_meaningful is False
    assert note.provenance == "unknown"
    assert note not in flow.default_nodes()


def test_kwargs_bind_by_parameter_name(tmp_path):
    """JSON input keys bind to DECLARED JS parameter names, not insertion order.

    Pins the fix for the car-rental session failure: a destructured options-object
    param receives the whole kwargs object; a multi-param function binds each key by
    name even when the JSON key order is shuffled; fn(opts) receives the whole object.
    """
    mod = tmp_path / "svc.js"
    mod.write_text(
        "function optsFn({ a, b } = {}) { return { sum: a + b }; }\n"
        "function multi(a, b, c) { return { got: [a, b, c] }; }\n"
        "function bag(opts) { return { keys: Object.keys(opts).sort() }; }\n"
        "module.exports = { optsFn, multi, bag };\n"
    )
    from dreplay.adapter.node_flow import node_flow

    f1 = node_flow(module_path=str(mod), func="optsFn", kwargs={"a": 2, "b": 3})
    ret1 = [n for n in f1.nodes if n.kind == "return"]
    assert ret1 and any(o.name == "sum" and o.value == 5 for o in ret1[0].operands)

    # shuffled key order must still bind by name
    f2 = node_flow(module_path=str(mod), func="multi", kwargs={"c": 3, "a": 1, "b": 2})
    ret2 = [n for n in f2.nodes if n.kind == "return"]
    assert ret2 and any(o.name == "got" and o.value == [1, 2, 3] for o in ret2[0].operands)

    f3 = node_flow(module_path=str(mod), func="bag", kwargs={"x": 1, "y": 2})
    ret3 = [n for n in f3.nodes if n.kind == "return"]
    assert ret3 and any(o.name == "keys" and o.value == ["x", "y"] for o in ret3[0].operands)
