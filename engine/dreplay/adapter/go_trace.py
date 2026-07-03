"""Go source instrumentation — the tracer mechanism for the Go adapter.

Closes the Go adapter's interior gap the same way ``js_trace`` closes Node's: by
rewriting the target's source so each function emits an enter event (name + arg
values) and an exit event (return value). Go has no ``sys.settrace`` equivalent, so
AST rewrite is the honest route to OBSERVED interior nodes — no synthesis.

MECHANISM (spec §2): a small Go program (``_go_instrument/instrument.go``) parses the
target ``.go`` file with ``go/parser`` + ``go/ast`` and rewrites every function
declaration so its result list is NAMED, then prepends an enter hook + a deferred
exit hook that reads those named results. Because the results are named, every
``return EXPR`` assigns to them (Go semantics) — so the deferred hook OBSERVES the
actual return value on every exit path. Go is the authority on Go syntax; we never
regex it.

This module:
  * builds the instrumenter binary once (cached in a tempdir per process);
  * exposes :func:`rewrite` → ``(rewritten_source, ok)`` — ``ok=False`` when the
    toolchain is missing or the source won't parse; the caller then falls back to
    endpoints-only, never fakes a node.

HONESTY (docs/what-this-is.md §1, principle #7): if Go is not installed, or the source
does not parse, ``available()``/``rewrite`` report that and the adapter falls back to
endpoints-only. A faked interior node would be the one unrecoverable failure.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

_ADAPTER_DIR = os.path.dirname(os.path.abspath(__file__))
_INSTRUMENT_SRC = os.path.join(_ADAPTER_DIR, "_go_instrument", "instrument.go")
_DREPLAY_ROOT = os.path.dirname(os.path.dirname(_ADAPTER_DIR))

# Cached instrumenter binary path (built on first use). Per-process tempdir.
_BINARY_CACHE: list[str | None] = [None]


def available() -> bool:
    """True if the Go toolchain AND the instrumenter source are present."""
    return shutil.which("go") is not None and os.path.isfile(_INSTRUMENT_SRC)


def _get_binary() -> str | None:
    """Build (once) and return the path to the instrumenter binary, or None."""
    if _BINARY_CACHE[0] is not None:
        return _BINARY_CACHE[0]
    if not available():
        return None
    tmpdir = tempfile.mkdtemp(prefix="dreplay_goinst_")
    out = os.path.join(tmpdir, "instrument")
    try:
        proc = subprocess.run(
            ["go", "build", "-o", out, _INSTRUMENT_SRC],
            capture_output=True, text=True, timeout=120,
            env={**os.environ, "GO111MODULE": "off"},
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if proc.returncode != 0:
        return None
    _BINARY_CACHE[0] = out
    return out


def rewrite(source: str) -> tuple[str, bool]:
    """Return ``(rewritten_source, ok)``.

    ``ok=False`` if Go/the instrumenter is unavailable or the source does not parse —
    the caller falls back to endpoints-only (never a faked node). When ``ok=True`` but
    nothing was rewriteable, the source is returned unchanged (still valid Go).
    """
    binary = _get_binary()
    if binary is None:
        return source, False
    try:
        proc = subprocess.run(
            [binary], input=source, capture_output=True, text=True, timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return source, False
    if proc.returncode != 0:
        return source, False  # instrumenter reported a parse/internal error
    return proc.stdout, True
