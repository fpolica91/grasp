"""Egress control — denied by default (principle 4: safe by construction).

Because this host cannot ``unshare -n`` (no network namespace — see the plan's
Environment Constraints), egress is enforced at the **socket and library layer**
inside the worker subprocess: outbound connects and HTTP calls are monkeypatched
to capture their payload and raise :class:`EgressBlocked` for non-allowlisted
hosts. This is strong at the Python layer but NOT kernel-level — a native C
extension or a spawned subprocess (e.g. ``curl``) could bypass it. That limit is
named in every scope statement's ``trust_boundary``.
"""
from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlparse

from .canonical import canonicalize
from .types import Policy

# Shown when a user passes --allow-egress. Names the risk (principle 4).
ALLOW_EGRESS_WARNING = (
    "WARNING: --allow-egress UNLOCKS outbound network from the code under test.\n"
    "The replay multiplies every side-effect by (self-diff runs + variants) x 2 "
    "branches. Only enable against code you trust, in an environment you control, "
    "and never with production credentials in scope. Egress remains socket/library-"
    "level interception, not kernel isolation."
)


class EgressBlocked(Exception):
    """Raised inside the worker when an outbound call is denied or fails.

    Carries the boundary record so the worker can decide whether execution
    stopped (uncaught) or continued (caught by the code under test).
    """

    def __init__(self, record: dict) -> None:
        super().__init__(record.get("reason", "egress blocked"))
        self.record = record


def host_from_url(url: str) -> str:
    """Extract the host from a URL or bare host string."""
    if "://" in url:
        return (urlparse(url).hostname or "").lower()
    # bare host[:port]
    return url.rsplit("/", 1)[0].split(":", 1)[0].lower()


def egress_decision(policy: Policy, host: str) -> Literal["allow", "deny"]:
    if policy.egress == "full":
        return "allow"
    if policy.egress == "allowlisted":
        return "allow" if host in policy.allowlist_hosts else "deny"
    return "deny"  # "denied"


def _record(
    collector: list,
    kind: str,
    target: dict,
    payload: Any,
    reason: str,
    intercepted_at: str,
    downstream: str,
) -> dict:
    rec = {
        "kind": kind,
        "target": target,
        "payload": (payload.shape if isinstance(payload, object) and hasattr(payload, "shape") else payload),
        "payload_unstructured": getattr(payload, "unstructured", False),
        "reason": reason,
        "downstream_coverage_lost": downstream,
        "intercepted_at": intercepted_at,
    }
    collector.append(rec)
    return rec


def install_interception(policy: Policy, collector: list, call_counts: dict) -> None:
    """Monkeypatch socket + urllib (+ requests/httpx if present) so outbound calls
    are denied/capped per ``policy``.

    Two concerns, decoupled by egress mode:
      * the **deny wall** (raw-socket guard + child-process exec block) is a SAFETY
        measure — installed only when egress is restricted (denied/allowlisted);
      * the **library hooks** are installed ALWAYS, because expensive-dep budgets
        must be honored even under ``egress="full"`` (cost is orthogonal to safety).

    ``call_counts`` is written by the gate: it records ALLOWED expensive-dep calls
    so the orchestrator can decrement the global budget across subprocesses.
    """
    if policy.egress == "full" and not policy.expensive_deps:
        return  # truly nothing to do: egress open, no metered dep to cap

    counts: dict = {}  # per-invocation attempt counter for expensive caps

    if policy.egress != "full":
        _install_socket_wall(policy, collector)

    _install_urllib_hook(policy, collector, counts, call_counts)
    _install_requests_hook(policy, collector, counts, call_counts)
    _install_httpx_hook(policy, collector, counts, call_counts)

    if policy.egress != "full":
        _install_child_exec_block(policy, collector)


def _install_socket_wall(policy: Policy, collector: list) -> None:
    import socket as _socket

    _orig_socket = _socket.socket

    class _GuardedSocket(_orig_socket):  # type: ignore[misc, valid-type]
        def connect(self, address):
            host = address[0] if isinstance(address, tuple) else str(address)
            if egress_decision(policy, host) == "deny":
                rec = _record(
                    collector,
                    "policy_block",
                    {"host": host, "port": address[1] if isinstance(address, tuple) else None},
                    None,
                    "egress denied (socket)",
                    "socket",
                    "Any result depending on this network call is unknowable.",
                )
                raise EgressBlocked(rec)
            try:
                return super().connect(address)
            except (BlockingIOError, OSError) as exc:  # real failure (timeout/refused/dns)
                _record(
                    collector,
                    "real_failure",
                    {"host": host, "port": address[1] if isinstance(address, tuple) else None},
                    None,
                    f"{type(exc).__name__}: {exc}",
                    "socket",
                    "A real outbound failure — possibly the bug.",
                )
                raise

    _socket.socket = _GuardedSocket


def _install_urllib_hook(policy: Policy, collector: list, counts: dict, call_counts: dict) -> None:
    import urllib.request as _ur

    _orig_urlopen = _ur.urlopen

    def _guarded_urlopen(url, *args, **kwargs):
        if isinstance(url, _ur.Request):
            req = url
        else:
            data = args[0] if args else kwargs.get("data")
            req = _ur.Request(url, data=data)
        host = host_from_url(req.full_url)
        method = req.get_method()
        payload = canonicalize(
            {
                "url": req.full_url,
                "method": method,
                "data": _maybe_json(_decode(req.data)),
                "headers": dict(req.headers),
            }
        )
        _gate(policy, counts, call_counts, collector, host=host,
              target={"host": host, "method": method}, payload=payload, lib="urllib")
        return _orig_urlopen(url, *args, **kwargs)

    _ur.urlopen = _guarded_urlopen

    # Child-process / exec block. A freshly exec'd process gets a clean
    # interpreter WITHOUT these monkeypatches, so it walks straight through the
    # socket/library wall (proven by tests/test_egress_wall.py). We cannot patch
    # the child, so we block the act of spawning one — and RECORD it, so the
    # escape is a visible boundary, never a silent omission. (A plain os.fork()
    # without exec keeps our patched socket in memory and stays walled, so we do
    # not block bare fork — only the exec of a new process image.)
    _install_child_exec_block(policy, collector)


def _decode(data) -> str | None:
    if data is None:
        return None
    if isinstance(data, bytes):
        try:
            return data.decode()
        except UnicodeDecodeError:
            return data.hex()
    return str(data)


def _maybe_json(text):
    """Parse a decoded request body as JSON when possible, so outbound payload
    diffs are field-path-aware (e.g. ``data.currency``) instead of opaque strings."""
    import json

    if not isinstance(text, str):
        return text
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text


def _install_child_exec_block(policy: Policy, collector: list) -> None:
    """Block exec of new process images (the child-process egress bypass).

    Under anything but ``egress="full"`` we cannot contain a freshly exec'd
    process, so spawning one is denied and recorded as a boundary. The code under
    test sees an :class:`EgressBlocked` (a real, honest stop), not a silent pass.
    """
    import os as _os
    import subprocess as _sp

    def _block(what: str):
        rec = _record(
            collector,
            "policy_block",
            {"command": what},
            None,
            (
                "child-process exec blocked: a freshly exec'd process escapes "
                "Python-layer egress interception and cannot be contained on this "
                "host (no kernel network namespace)."
            ),
            "process",
            "Anything the child process would have done is unobserved and unknowable.",
        )
        raise EgressBlocked(rec)

    _orig_popen_init = _sp.Popen.__init__

    def _guarded_popen_init(self, args, *a, **k):  # type: ignore[no-untyped-def]
        _block(_describe(args))
        return _orig_popen_init(self, args, *a, **k)  # unreachable

    _sp.Popen.__init__ = _guarded_popen_init  # type: ignore[assignment]

    # os-level spawners that exec a new image (fork+exec under the hood). os.exec*
    # replaces the current image; os.spawn*/posix_spawn fork+exec a child.
    _exec_names = (
        "system", "posix_spawn", "posix_spawnp",
        "execv", "execve", "execvp", "execvpe",
        "execl", "execle", "execlp", "execlpe",
        "spawnv", "spawnve", "spawnvp", "spawnvpe",
        "spawnl", "spawnle", "spawnlp", "spawnlpe",
    )
    for _name in _exec_names:
        if not hasattr(_os, _name):
            continue
        def _make(name):
            def _guarded(*a, **k):  # type: ignore[no-untyped-def]
                arg = a[1] if name.startswith(("exec", "spawn")) and len(a) > 1 else (a[0] if a else name)
                _block(_describe(arg))
            return _guarded
        setattr(_os, _name, _make(_name))


def _describe(args) -> str:
    if isinstance(args, (list, tuple)):
        return " ".join(str(x) for x in args)[:200]
    return str(args)[:200]


def _expensive_for_host(policy: Policy, host: str):
    """Return ``(name, max_calls)`` if ``host`` is a declared expensive dep, else None."""
    for name, cfg in (policy.expensive_deps or {}).items():
        if (cfg.get("host") or "").lower() == host:
            return name, int(cfg.get("max_calls", 0))
    return None


def _budget_for(policy: Policy, name: str, declared_max: int) -> int:
    """Calls still allowed for ``name`` in THIS invocation. Prefers the
    orchestrator-injected global remaining; falls back to the declared max when no
    remaining was injected (direct run_entrypoint calls / unit tests)."""
    if policy.expensive_remaining:
        return int(policy.expensive_remaining.get(name, 0))
    return declared_max


def _gate(policy: Policy, counts: dict, call_counts: dict, collector: list,
          *, host, target, payload, lib) -> None:
    """Decide one outbound library call: raise :class:`EgressBlocked` to deny, or
    return to allow. Egress policy first; then the expensive-dep budget.

    The budget is GLOBAL for the whole check (injected per-invocation as the
    remaining slice). An allowed metered call increments ``call_counts[name]`` so
    the orchestrator can decrement the global budget across subprocesses."""
    if egress_decision(policy, host) == "deny":
        rec = _record(collector, "policy_block", target, payload,
                      f"egress denied ({lib})", "library",
                      "Any result depending on this call is unknowable.")
        raise EgressBlocked(rec)
    exp = _expensive_for_host(policy, host)
    if exp is not None:
        name, declared_max = exp
        budget = _budget_for(policy, name, declared_max)
        counts[name] = counts.get(name, 0) + 1
        if counts[name] > budget:
            rec = _record(
                collector, "policy_block", target, payload,
                f"expensive-dep budget exhausted for '{name}' "
                f"(global max_calls reached for this check)", "library",
                "Call capped to avoid metered cost / rate limits.")
            raise EgressBlocked(rec)
        call_counts[name] = call_counts.get(name, 0) + 1  # an allowed metered call


def _install_requests_hook(policy: Policy, collector: list, counts: dict, call_counts: dict) -> None:
    try:
        import requests as _r  # noqa: F401
    except Exception:  # noqa: BLE001
        return
    _orig = _r.request  # type: ignore[attr-defined]

    def _guarded(method, url, **kwargs):
        host = host_from_url(str(url))
        payload = canonicalize(
            {"url": str(url), "method": method, "json": kwargs.get("json"), "data": kwargs.get("data")}
        )
        _gate(policy, counts, call_counts, collector, host=host,
              target={"host": host, "method": method}, payload=payload, lib="requests")
        return _orig(method, url, **kwargs)

    _r.request = _guarded  # type: ignore[assignment]


def _install_httpx_hook(policy: Policy, collector: list, counts: dict, call_counts: dict) -> None:
    try:
        import httpx as _h  # noqa: F401
    except Exception:  # noqa: BLE001
        return
    _orig = _h.request  # type: ignore[attr-defined]

    def _guarded(method, url, **kwargs):
        host = host_from_url(str(url))
        payload = canonicalize({"url": str(url), "method": method, "json": kwargs.get("json")})
        _gate(policy, counts, call_counts, collector, host=host,
              target={"host": host, "method": method}, payload=payload, lib="httpx")
        return _orig(method, url, **kwargs)

    _h.request = _guarded  # type: ignore[assignment]
