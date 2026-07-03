"""Conformance test for the C++ FLOW-mode adapter (spec §2, §8.8).

Pins the honesty contract for the C++ adapter:

* call/return nodes are OBSERVED (real GCC -finstrument-functions tracing);
* the entrypoint return value is OBSERVED (the harness reads the real return);
* every operand provenance is one of observed/declared/unknown (the type-system
  guard in ``Operand.__post_init__`` enforces this at construction);
* interior operand VALUES are the labelled honest gap (not fabricated) — the
  per-event ``locals`` are empty, but call/return STRUCTURE + timing are real.

If ``g++`` is not on PATH the whole module skips — the adapter is never faked
(principle #7: do not fake the plumbing).

NOTE on the fixture source: the entrypoint functions return a JSON document as a
``std::string`` (the adapter contract). To avoid brittle C++ quote-escaping
inside this Python triple-quoted string, each fixture builds its JSON with a
``Q`` macro (a literal double-quote char) — e.g. ``"{" Q "ok" Q ":true}"``.
"""
from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

import pytest

from dreplay.adapter.cpp_flow import (
    cpp_flow,
    derive_cpp_vocabulary,
    status_line,
)
from dreplay.flow import Flow

pytestmark = pytest.mark.skipif(
    shutil.which("g++") is None,
    reason="g++ not on PATH — C++ adapter cannot compile/run",
)

# A helper prepended to every fixture: a quote constant + a tiny JSON kv builder,
# so the entrypoint can return a JSON std::string WITHOUT hand-escaping quotes
# inside this Python triple-quoted string. ``q`` is one double-quote; ``kv``
# builds a "key":value pair.
_Q_HELPER = (
    "#include <string>\n"
    "#include <stdexcept>\n"
    "static const std::string q = std::string(1, (char)34);\n"
)


def _write_source(tmp_path: Path, body: str) -> Path:
    src = tmp_path / "target.cpp"
    src.write_text(_Q_HELPER + textwrap.dedent(body))
    return src


def test_call_and_return_nodes_observed(tmp_path):
    """A function that calls a helper produces a Flow with observed call +
    return nodes (the core proof-of-seam for the C++ tracer)."""
    src = _write_source(tmp_path, """\
        // A helper the entrypoint calls — its call should be observed.
        int classify_helper(int x) {
            int doubled = x * 2;
            return doubled;
        }

        // The entrypoint. Returns JSON (std::string) per the adapter contract.
        // JSON built with the `q` quote constant to avoid quote-escaping.
        std::string classify(int x) {
            int v = classify_helper(x);
            std::string tag = (v > 0) ? "pos" : "neg";
            return "{" + q + "ok" + q + ":true," + q + "tag" + q + ":" + q + tag + q + "}";
        }
    """)

    flow = cpp_flow(source_path=str(src), func="classify", kwargs={"x": 5})

    assert isinstance(flow, Flow)
    # The default view must contain input + return (both business-meaningful).
    default = flow.default_nodes()
    kinds = [n.kind for n in default]
    assert "input" in kinds
    assert "return" in kinds

    # The return node binds the observed business fields (ok, tag).
    ret = next(n for n in default if n.kind == "return")
    names = {o.name for o in ret.operands}
    assert "ok" in names and "tag" in names
    ok = next(o for o in ret.operands if o.name == "ok")
    assert ok.value is True and ok.provenance == "observed"

    # Honesty: every operand provenance is valid.
    for op in flow.all_operands():
        assert op.provenance in ("observed", "declared", "unknown")


def test_helper_call_is_observed(tmp_path):
    """The helper function call is observed as a node (interior call structure
    is real; this is what -finstrument-functions gives us)."""
    src = _write_source(tmp_path, """\
        int doubled_value(int x) { return x * 2; }
        std::string run(int n) {
            int r = doubled_value(n);
            return "{" + q + "value" + q + ":" + std::to_string(r) + "}";
        }
    """)
    flow = cpp_flow(source_path=str(src), func="run", kwargs={"n": 7})

    # The helper 'doubled_value' must appear among the observed call nodes.
    labels = {n.label for n in flow.nodes}
    assert any("doubled_value" in lab for lab in labels), (
        f"helper call not observed; labels={labels}"
    )


def test_exception_observed(tmp_path):
    """A thrown C++ exception is captured; a thrown path does NOT produce a
    clean business-field return node."""
    src = _write_source(tmp_path, """\
        std::string deny(int code) {
            if (code < 0) throw std::runtime_error("negative code");
            return "{" + q + "ok" + q + ":true}";
        }
    """)
    flow = cpp_flow(source_path=str(src), func="deny", kwargs={"code": -1})

    default = flow.default_nodes()
    # The tracer captures the exception via dreplay_invoke's catch; the adapter
    # surfaces it as an OBSERVED thrown-error node.
    err = next((n for n in default if n.kind == "other"
                and n.label == "thrown-error"), None)
    assert err is not None, "a thrown C++ exception must surface as an observed error node"
    msg = next(o for o in err.operands if o.name == "message")
    assert "negative code" in str(msg.value)
    assert msg.provenance == "observed"
    # No clean return node when the function threw.
    assert not any(n.kind == "return" for n in default), \
        "a thrown exception must not yield a clean return node"


def test_vocab_deriver_reads_struct_fields(tmp_path):
    """The regex vocab deriver reads field names from a C++ struct declaration."""
    src = _write_source(tmp_path, """\
        struct Order {
            int amount;
            std::string owner;
            const std::string currency;
            double price = 0.0;
            void compute() {}   // method — must NOT be a field
        };
        std::string make(int a) {
            return "{" + q + "amount" + q + ":" + std::to_string(a) + "}";
        }
    """)
    fields = derive_cpp_vocabulary([str(src)])
    assert "amount" in fields
    assert "owner" in fields
    assert "currency" in fields
    assert "price" in fields
    assert "compute" not in fields  # method, not a field


def test_status_line(tmp_path):
    """The adapter prints the mode-transparency status line."""
    src = _write_source(tmp_path, """\
        std::string go(int x) { return "{}"; }
    """)
    line = status_line(str(src), {"amount", "owner"})
    assert "adapter=cpp-fn" in line
    assert "classifier_mode=vocab" in line
    assert "vocab_count=2" in line

    line2 = status_line(str(src), set())
    assert "classifier_mode=non_vocab" in line2
    assert "vocab_count=0" in line2


def test_multiple_kwargs_are_not_silently_corrupted(tmp_path):
    """Regression (ultracode probe, 2026-07-02): the harness decoded argv with a
    stride of 2 while the encoder emitted 3 tokens per kwarg (--type NAME VALUE),
    so every kwarg after the first read its NAME token instead of its value
    (atoi("b")==0) — silent input substitution. Pin all three positions."""
    src = _write_source(tmp_path, """\
        // Echo all three args into the return so a misdecode is visible.
        std::string combine(int a, int b, int c) {
            int sum = a + b + c;
            return "{" + q + "sum" + q + ":" + std::to_string(sum) + ","
                 + q + "a" + q + ":" + std::to_string(a) + ","
                 + q + "b" + q + ":" + std::to_string(b) + ","
                 + q + "c" + q + ":" + std::to_string(c) + "}";
        }
    """)
    flow = cpp_flow(source_path=str(src), func="combine", kwargs={"a": 10, "b": 20, "c": 30})
    ret = next(n for n in flow.default_nodes() if n.kind == "return")
    vals = {o.name: o.value for o in ret.operands}
    assert vals.get("a") == 10, f"first kwarg; got {vals}"
    assert vals.get("b") == 20, f"second kwarg must not be read as NAME token; got {vals}"
    assert vals.get("c") == 30, f"third kwarg must decode correctly; got {vals}"
    assert vals.get("sum") == 60, f"a+b+c must be 60, not corrupted; got {vals}"
