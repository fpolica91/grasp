"""Kernel-level egress denial via a seccomp-bpf syscall filter (libseccomp).

This is the containment that closes the native-egress hole the Python-layer wall
cannot: a seccomp filter denies the ``connect`` syscall *in the kernel*, so a
native C HTTP client, native gRPC, asyncpg, or any statically-linked binary is
blocked exactly like ordinary Python — without root and without a network
namespace. It keeps the team's real interpreter and real dependencies (full
behavioral fidelity), which is why it is preferred over a WASM/alternate runtime.

Mechanism: we drive the system ``libseccomp.so`` through ctypes. libseccomp
resolves syscall numbers for the running architecture (x86_64, aarch64, ...), so
we never hard-code arch-specific numbers, and ``seccomp_load`` sets
``NO_NEW_PRIVS`` for us, so no privilege is required.

What we block (all in-kernel, for native code and child processes alike):
* ``connect`` — every TCP egress path (HTTP, gRPC, Postgres/asyncpg, the named
  native threats) plus connect-then-send UDP and the glibc resolver's DNS path.
* creation of ``AF_INET``/``AF_INET6`` ``SOCK_DGRAM``/``SOCK_RAW`` sockets — closes
  connection-less ``sendto`` UDP exfil that ``connect`` alone misses. We filter at
  socket *creation* (a register-value arg seccomp CAN inspect) rather than on
  ``sendto`` (whose destination is in memory seccomp can't read), so AF_UNIX local
  IPC / logging keeps working untouched.

Honest limits:
* Applied only for ``egress="denied"`` (the blanket default). Per-host allowlists
  cannot be expressed in seccomp (it cannot dereference the sockaddr), so
  ``allowlisted`` stays on the Python layer.
* Raw packet egress would need an ``AF_PACKET`` socket (CAP_NET_RAW) — which an
  unprivileged worker does not have — so it is out of reach regardless.
"""
from __future__ import annotations

import ctypes
import os
import socket as _socket_mod
import subprocess
import sys

# Syscalls denied at the kernel. 'connect' covers all TCP + connected UDP. We
# ALSO deny creation of IP datagram/raw sockets (see _deny_ip_dgram_raw), which
# closes connection-less native UDP sendto() exfil that connect() alone misses.
_DENIED_SYSCALLS = ("connect",)

_EPERM = 1
_SCMP_ACT_ALLOW = 0x7FFF0000

# libseccomp arg-comparison ops + the socket() type mask (low byte is the type;
# SOCK_CLOEXEC/SOCK_NONBLOCK live in higher bits, so mask them off).
_SCMP_CMP_EQ = 4
_SCMP_CMP_MASKED_EQ = 7
_SOCK_TYPE_MASK = 0xFF


class _scmp_arg_cmp(ctypes.Structure):
    _fields_ = [
        ("arg", ctypes.c_uint),       # syscall argument index
        ("op", ctypes.c_int),         # comparison op
        ("datum_a", ctypes.c_uint64),
        ("datum_b", ctypes.c_uint64),
    ]


def _scmp_act_errno(errno: int) -> int:
    return 0x00050000 | (errno & 0x0000FFFF)


def _deny_ip_dgram_raw(lib: ctypes.CDLL, ctx, action: int) -> bool:
    """Deny socket(AF_INET/AF_INET6, SOCK_DGRAM|SOCK_RAW, *) at the kernel.

    This is the surgical close for connection-less native UDP (and raw) egress:
    it blocks creating an IP datagram/raw socket at all, while leaving TCP
    (SOCK_STREAM — handled by the connect() rule) and AF_UNIX local IPC (logging)
    completely untouched. Returns False on a hard failure to add a rule.
    """
    lib.seccomp_rule_add_array.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
        ctypes.POINTER(_scmp_arg_cmp),
    ]
    sock_nr = lib.seccomp_syscall_resolve_name(b"socket")
    if sock_nr < 0:
        return True  # no socket() syscall on this arch — nothing to add
    families = [getattr(_socket_mod, n) for n in ("AF_INET", "AF_INET6") if hasattr(_socket_mod, n)]
    socktypes = [getattr(_socket_mod, n) for n in ("SOCK_DGRAM", "SOCK_RAW") if hasattr(_socket_mod, n)]
    for fam in families:
        for typ in socktypes:
            arr = (_scmp_arg_cmp * 2)(
                _scmp_arg_cmp(0, _SCMP_CMP_EQ, int(fam), 0),
                _scmp_arg_cmp(1, _SCMP_CMP_MASKED_EQ, _SOCK_TYPE_MASK, int(typ)),
            )
            if lib.seccomp_rule_add_array(ctx, action, sock_nr, 2, arr) != 0:
                return False
    return True


def _load_lib() -> ctypes.CDLL | None:
    # Load by soname directly. We deliberately avoid ctypes.util.find_library,
    # which shells out to ldconfig/gcc — a subprocess the worker's own egress
    # exec-block would deny, deadlocking the very filter we are trying to arm.
    for soname in ("libseccomp.so.2", "libseccomp.so"):
        try:
            return ctypes.CDLL(soname, use_errno=True)
        except OSError:
            continue
    return None


def _install(lib: ctypes.CDLL) -> bool:
    """Build + load the egress-deny filter into the CURRENT process. Irreversible
    (a loaded seccomp filter cannot be removed) — only call in a worker/child."""
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]

    ctx = lib.seccomp_init(_SCMP_ACT_ALLOW)
    if not ctx:
        return False
    try:
        added = 0
        for name in _DENIED_SYSCALLS:
            num = lib.seccomp_syscall_resolve_name(name.encode())
            if num < 0:  # __NR_SCMP_ERROR / not known on this arch
                continue
            if lib.seccomp_rule_add(ctx, _scmp_act_errno(_EPERM), num, 0) != 0:
                return False
            added += 1
        if added == 0:
            return False
        if not _deny_ip_dgram_raw(lib, ctx, _scmp_act_errno(_EPERM)):
            return False
        return lib.seccomp_load(ctx) == 0
    finally:
        lib.seccomp_release(ctypes.c_void_p(ctx))


def available() -> bool:
    """True iff a seccomp egress filter can actually be installed here.

    Proven empirically by installing the real filter in a throwaway SUBPROCESS
    (which then exits), so the probe never sticks a filter onto the caller and —
    unlike fork() — is safe to call from a multi-threaded process. No guessing.
    Only ever called in the parent (never the egress-blocked worker).
    """
    if _load_lib() is None:
        return False
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    code = (
        f"import sys; sys.path.insert(0, {root!r}); "
        "from dreplay import _seccomp; "
        "sys.exit(0 if _seccomp.install() else 1)"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, timeout=10
        )
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def install() -> bool:
    """Install the egress-deny filter into the current (worker) process."""
    lib = _load_lib()
    if lib is None:
        return False
    return _install(lib)
