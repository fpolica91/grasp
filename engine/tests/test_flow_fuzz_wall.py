"""Adversarial pin for Mode B's kernel egress wall — the flow-side analogue of
``test_egress_wall``.

The fuzz pass multiplies real executions ×N variants, so unlike Mode A it runs
WALLED by default (docs/what-this-is.md §safety): kernel egress containment
(seccomp connect-deny, or a fresh netns), and a hard refusal when neither
exists. These tests prove the claim against a real listener:

* under walled fuzz the connection is NEVER made, and the denial is OBSERVED
  (a thrown-error node), not silent;
* the same target with ``egress="full"`` DOES connect — the control that proves
  this harness would catch a broken wall;
* with no kernel containment, walled fuzz refuses (``FuzzRefusal``) instead of
  running unwalled.
"""
from __future__ import annotations

import socket
import threading
from types import SimpleNamespace

import pytest

from dreplay import containment
from dreplay.flow_fuzz import FuzzRefusal, fuzz_flow
from dreplay.types import ImplSpec

_LEVEL = containment.detect().level
_KERNEL = _LEVEL in ("seccomp", "kernel_netns")

_TARGET = '''\
import os
import socket


def phone_home(token: str) -> dict:
    port = int(os.environ["DREPLAY_FUZZ_WALL_PORT"])
    s = socket.create_connection(("127.0.0.1", port), timeout=2)
    s.sendall(b"x")
    s.close()
    return {"status": "sent", "token": token}
'''

_SCHEMA = {"type": "object", "properties": {"token": {"type": "string"}}, "required": ["token"]}


def _listener():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    srv.settimeout(0.2)
    hits: list[int] = []
    stop = threading.Event()

    def _accept():
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
                hits.append(1)
                conn.close()
            except socket.timeout:
                continue
            except OSError:
                break

    t = threading.Thread(target=_accept, daemon=True)
    t.start()
    return srv, hits, stop, t


def _write_target(tmp_path) -> str:
    (tmp_path / "phone_home_target.py").write_text(_TARGET)
    return str(tmp_path)


@pytest.mark.skipif(not _KERNEL, reason=f"no kernel egress containment on this host (level={_LEVEL})")
def test_walled_fuzz_never_reaches_the_listener(tmp_path, monkeypatch):
    srv, hits, stop, t = _listener()
    try:
        monkeypatch.setenv("DREPLAY_FUZZ_WALL_PORT", str(srv.getsockname()[1]))
        report = fuzz_flow(
            spec=ImplSpec(module="phone_home_target", func="phone_home"),
            schema=_SCHEMA, variant_count=3, seed=0,
            python_path=[_write_target(tmp_path)],  # egress defaults to "walled"
        )
    finally:
        stop.set()
        t.join(timeout=2)
        srv.close()
    assert hits == [], "walled fuzz must never reach the network"
    assert report.egress == "walled"
    assert report.containment_level == _LEVEL
    # The denial is OBSERVED, not silent: every variant surfaced the raise.
    for f in report.flows:
        assert any(n.label == "thrown-error" for n in f.nodes), \
            "the denied connect must surface as an observed thrown-error node"


def test_full_egress_control_reaches_the_listener(tmp_path, monkeypatch):
    """The control that proves this harness can catch a broken wall: the same
    target run with egress='full' really connects."""
    srv, hits, stop, t = _listener()
    try:
        monkeypatch.setenv("DREPLAY_FUZZ_WALL_PORT", str(srv.getsockname()[1]))
        report = fuzz_flow(
            spec=ImplSpec(module="phone_home_target", func="phone_home"),
            schema=_SCHEMA, variant_count=2, seed=0,
            python_path=[_write_target(tmp_path)], egress="full",
        )
    finally:
        stop.set()
        t.join(timeout=2)
        srv.close()
    assert hits, "control run (egress='full') must actually reach the listener"
    assert not any(n.label == "thrown-error" for f in report.flows for n in f.nodes)


def test_walled_default_refuses_without_kernel_containment(monkeypatch):
    import dreplay.flow_fuzz as ff

    monkeypatch.setattr(ff.containment, "detect",
                        lambda: SimpleNamespace(level="python_layer"))
    with pytest.raises(FuzzRefusal):
        fuzz_flow(
            spec=ImplSpec(module="flow_canaries.scenarios", func="authenticate"),
            schema=_SCHEMA, variant_count=2, seed=0,
        )
