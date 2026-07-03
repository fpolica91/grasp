"""Egress containment detection — is the wall a guarantee, or best-effort?

Principle #4 ("safe by construction") requires the code under test to be
*physically* unable to reach the network by default. That is only true with a
kernel-enforced boundary (a network namespace). Without one, egress control
degrades to Python-layer monkeypatching (``egress.py`` + the child-exec block in
``sandbox.py``), which a native extension calling ``connect()`` directly — or a
freshly ``exec``'d child process — can bypass.

This module reports which world we are in, so the engine can FAIL CLOSED: refuse
the fuzz-spam loop under weak containment rather than proceed on a guarantee it
cannot keep (the exact "your tool lied" failure mode). Detection is empirical —
we actually try to enter a network namespace; we never assume.
"""
from __future__ import annotations

import functools
import subprocess
from dataclasses import dataclass
from typing import Literal

from . import _seccomp

Level = Literal["kernel_netns", "seccomp", "python_layer"]


@dataclass(frozen=True)
class Containment:
    """The strongest egress boundary available on this host.

    ``can_guarantee_egress_denial`` is the load-bearing field: when False, the
    fuzz-spam loop must refuse by default (principle #4 cannot be honored, only
    approximated).
    """

    level: Level
    can_guarantee_egress_denial: bool
    summary: str
    residual_risk: str


_PYTHON_LAYER = Containment(
    level="python_layer",
    can_guarantee_egress_denial=False,
    summary=(
        "Python-layer egress interception only (socket/library monkeypatch + "
        "child-process exec block). No kernel network namespace on this host."
    ),
    residual_risk=(
        "A native extension calling connect() directly — a C HTTP client, native "
        "gRPC, asyncpg — bypasses Python-layer interception and is NOT recorded. "
        "The fuzz-spam loop is therefore refused by default under this containment."
    ),
)

_SECCOMP = Containment(
    level="seccomp",
    can_guarantee_egress_denial=True,
    summary=(
        "seccomp-bpf syscall filter available — the worker denies the connect() "
        "syscall in the kernel, blocking native code and child processes too, "
        "while keeping the team's real interpreter and dependencies."
    ),
    residual_risk=(
        "TCP egress (the named native threats — libcurl, native gRPC, asyncpg) is "
        "kernel-denied via connect(), and IP datagram/raw socket creation is "
        "denied too, so connection-less UDP exfil is blocked. AF_UNIX local IPC "
        "is intentionally still allowed. (Raw packet egress would need CAP_NET_RAW, "
        "which an unprivileged worker does not have.)"
    ),
)

_KERNEL_NETNS = Containment(
    level="kernel_netns",
    can_guarantee_egress_denial=True,
    summary=(
        "Kernel network namespace available — the worker runs under 'unshare -n', "
        "so egress is blocked by the kernel for native code and child processes too."
    ),
    residual_risk="None at the network layer — egress denial is kernel-enforced.",
)


@functools.lru_cache(maxsize=1)
def detect() -> Containment:
    """Probe the strongest egress-containment boundary available on this host.

    Strength order: kernel_netns > seccomp > python_layer. Cached: the host's
    capability does not change within a process. Tests that need a specific level
    should pass ``containment=`` explicitly rather than relying on the host.
    """
    if _can_unshare_net():
        return _KERNEL_NETNS
    if _seccomp.available():
        return _SECCOMP
    return _PYTHON_LAYER


def guarantees_denial(c: Containment, egress: str) -> bool:
    """Whether ``c`` actually guarantees egress denial under this ``egress`` mode.

    seccomp guarantees only the blanket ``denied`` case (it cannot express a
    per-host allowlist); netns blocks everything; python_layer never guarantees.
    """
    if c.level == "kernel_netns":
        return True
    if c.level == "seccomp":
        return egress == "denied"
    return False


def _can_unshare_net() -> bool:
    """True iff this host actually lets us enter a fresh network namespace.

    We run the cheapest possible command inside the namespace; success means the
    kernel granted the unshare (CLONE_NEWNET) — the real test, not a guess.
    """
    try:
        proc = subprocess.run(
            ["unshare", "-n", "true"],
            capture_output=True,
            timeout=5,
        )
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def worker_prefix(containment: Containment, egress: str) -> list[str]:
    """Command prefix that wraps the worker subprocess in kernel egress isolation.

    Returns ``["unshare", "-n"]`` only when a network namespace is genuinely
    available AND egress is being restricted (not ``"full"``). Otherwise empty —
    there is nothing real to prepend, and we must not pretend there is.
    """
    if containment.level == "kernel_netns" and egress != "full":
        return ["unshare", "-n"]
    return []
