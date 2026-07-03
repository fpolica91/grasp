"""P1 — evidence surfacing: the observed flow carries the run's stdout/stderr as
display-only evidence ("show what happened so you can confirm it") without turning
it into a compared behavior or a verdict.

Pins: evidence reaches the terminal node's raw_detail + JSON + HTML; it is
deterministic and address-scrubbed; silent runs are byte-identical to before; the
evidence never enters the flow-diff; and no verdict words are introduced.
"""
from __future__ import annotations

import json
import os

from dreplay.flow import observe_flow
from dreplay.flow_diff import align_and_diff
from dreplay.flow_render import to_html, to_json
from dreplay.types import ImplSpec


def _repo(tmp_path, body: str, name: str = "svc.py") -> str:
    (tmp_path / name).write_text(body)
    return str(tmp_path)


def _flow(tmp_path, body, func, kwargs, name="svc.py"):
    repo = _repo(tmp_path, body, name)
    mod = name[:-3]
    return observe_flow(spec=ImplSpec(module=mod, func=func), kwargs=kwargs, python_path=[repo])


def test_stdout_stderr_surface_on_terminal_node(tmp_path):
    flow = _flow(
        tmp_path,
        "def charge(customer_id, amount):\n"
        "    print(f'Charging {customer_id} ${amount}')\n"
        "    import sys; sys.stderr.write('WARN: no idempotency key\\n')\n"
        "    return {'customer_id': customer_id, 'charged': True}\n",
        "charge", {"customer_id": 7, "amount": 5},
    )
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert ret.raw_detail is not None
    assert "Charging 7 $5" in ret.raw_detail            # stdout observed
    assert "no idempotency key" in ret.raw_detail       # stderr observed
    assert "stdout" in ret.raw_detail and "stderr" in ret.raw_detail
    assert "observed" in ret.raw_detail                 # labeled as observed, not a claim


def test_evidence_reaches_json_and_html(tmp_path):
    flow = _flow(
        tmp_path,
        "def f(x):\n    print('side effect happened')\n    return {'x': x}\n",
        "f", {"x": 1},
    )
    doc = json.loads(to_json(flow))
    ret = next(n for n in doc["nodes"] if n["kind"] == "return")
    assert "raw_detail" in ret and "side effect happened" in ret["raw_detail"]
    html = to_html(flow)
    assert "side effect happened" in html
    assert "<pre class='detail'>" in html
    # self-contained: no external assets, no script
    assert "<script" not in html.lower() and "http://" not in html and "https://" not in html


def test_silent_run_is_byte_identical(tmp_path):
    """A run with no output must leave every node's raw_detail None, so existing
    flows/artifacts for silent code are unchanged by this feature."""
    flow = _flow(tmp_path, "def f(x):\n    return {'x': x}\n", "f", {"x": 1})
    assert all(n.raw_detail is None for n in flow.nodes)
    doc = json.loads(to_json(flow))
    assert all(n["raw_detail"] is None for n in doc["nodes"])


def test_evidence_is_deterministic(tmp_path):
    body = ("def f(x):\n    print('deterministic output', x)\n    return {'x': x}\n")
    a = _flow(tmp_path, body, "f", {"x": 3})
    b = _flow(tmp_path, body, "f", {"x": 3})
    ra = next(n for n in a.nodes if n.kind == "return").raw_detail
    rb = next(n for n in b.nodes if n.kind == "return").raw_detail
    assert ra == rb and ra is not None


def test_addresses_are_scrubbed_for_reproducibility(tmp_path):
    """A repr with a memory address in stdout must be scrubbed, or two runs of the
    same code would produce different 'observed' evidence (breaks principle #4)."""
    flow = _flow(
        tmp_path,
        "def f(x):\n    print(object())\n    return {'x': x}\n",
        "f", {"x": 1},
    )
    ret = next(n for n in flow.nodes if n.kind == "return")
    assert ret.raw_detail is not None
    assert "0xADDR" in ret.raw_detail          # scrubbed placeholder present
    import re
    assert not re.search(r"0x[0-9a-f]{6,}", ret.raw_detail)  # no raw address survived


def test_evidence_does_not_pollute_the_flow_diff(tmp_path):
    """raw_detail is display-only: two runs whose ONLY difference is stdout text
    must diff as unchanged (evidence is not a compared behavior)."""
    (tmp_path / "a.py").write_text(
        "def f(x):\n    print('version ONE says hello')\n    return {'x': x}\n")
    (tmp_path / "b.py").write_text(
        "def f(x):\n    print('version TWO says goodbye')\n    return {'x': x}\n")
    fa = observe_flow(spec=ImplSpec(module="a", func="f"), kwargs={"x": 1}, python_path=[str(tmp_path)])
    fb = observe_flow(spec=ImplSpec(module="b", func="f"), kwargs={"x": 1}, python_path=[str(tmp_path)])
    # different stdout, identical observable behavior (same operands/identity)
    assert fa.nodes[-1].raw_detail != fb.nodes[-1].raw_detail
    diff = align_and_diff(fa, fb)
    assert diff.is_empty(), "evidence-only differences must NOT surface as behavioral change"


def test_evidence_introduces_no_verdict_words(tmp_path):
    """The dreplay-emitted framing around evidence stays neutral (the moat). The
    program's OWN output is observed verbatim, but our labels never judge."""
    flow = _flow(tmp_path, "def f(x):\n    print('ok')\n    return {'x': x}\n", "f", {"x": 1})
    ret = next(n for n in flow.nodes if n.kind == "return")
    framing = ret.raw_detail.replace("ok", "")  # strip the program's own text
    for bad in ("bug", "risk", "vulnerab", "broken", "insecure", "danger"):
        assert bad not in framing.lower()


def test_thrown_run_carries_evidence_too(tmp_path):
    """A run that prints then raises: the thrown-error node carries the output."""
    flow = _flow(
        tmp_path,
        "def f(x):\n    print('got here before raising')\n    raise ValueError('boom')\n",
        "f", {"x": 1},
    )
    err = next(n for n in flow.nodes if n.label == "thrown-error")
    assert err.raw_detail is not None and "got here before raising" in err.raw_detail
