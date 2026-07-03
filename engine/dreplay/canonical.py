"""Canonical normalization + field-path diff.

Every captured value flows through :func:`canonicalize` into a JSON-serializable,
deterministic :class:`~dreplay.types.CanonicalValue`. :func:`diff` walks two
canonical values in parallel and emits per-path deltas.

Comparison defaults (surfaced in the scope statement):
* floats compared with a relative tolerance (``float_tol``);
* ``int`` vs ``float`` that are numerically equal (e.g. 2 vs 2.0) are NOT a
  divergence; ``bool`` vs anything IS a type change (bool is semantically distinct);
* ``set`` ordering is ignored (sets compare as sorted members);
* unknown objects fall back to ``repr()`` with ``unstructured=True`` (F3).
"""
from __future__ import annotations

import datetime
import enum
import math
import re
from dataclasses import dataclass
from typing import Any

from .types import CanonicalValue

# Memory addresses in repr() are never semantic and differ every process, so an
# object whose repr embeds one (CPython's default ``<X at 0x...>``, or a custom
# ``<X @ 140...>``) would otherwise look like a divergence on identical code.
# Scrub them to a stable placeholder. (Defense-in-depth with the noise mask, which
# only catches this if the noisy field happens to appear in the self-diff sample.)
_ADDR_RE = re.compile(r"(?:0x[0-9A-Fa-f]+|(?<=@ )\d{5,}|(?<=at )\d{5,})")


def _scrub_addresses(s: str) -> str:
    return _ADDR_RE.sub("0xADDR", s)


def canonicalize(value: Any, *, float_tol: float = 1e-9) -> CanonicalValue:
    shape, unstructured = _canon(value, float_tol)
    return CanonicalValue(shape=shape, unstructured=unstructured)


def _sortkey(value: Any) -> tuple:
    """A total order key for possibly-heterogeneous values (sets/dict keys)."""
    return (type(value).__name__, str(value))


_MAX_DEPTH = 60


def _canon(value: Any, float_tol: float, _seen: frozenset = frozenset(), _depth: int = 0) -> tuple[Any, bool]:
    if value is None or isinstance(value, bool):
        return value, False
    if isinstance(value, str):
        return value, False
    if isinstance(value, int):  # also IntEnum/IntFlag -> their int value
        return value, False
    if isinstance(value, float):
        if math.isnan(value):
            return {"__float__": "nan"}, False
        if math.isinf(value):
            return {"__float__": "inf" if value > 0 else "-inf"}, False
        return value, False
    if isinstance(value, bytes):
        return {"__bytes__": value.hex()}, False
    # Enum members reference their class, which references its members -> a reference
    # CYCLE. Canonicalize to a stable identity and do NOT walk __dict__ (would hang).
    if isinstance(value, enum.Enum):
        return {"__enum__": f"{type(value).__name__}.{value.name}"}, False
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return {"__iso__": value.isoformat()}, False

    # Below here we RECURSE. Guard against reference cycles (object on its own
    # ancestor path) and runaway depth, so a cyclic/huge object degrades to repr
    # instead of hanging the whole replay (real returns: ORM rows, graph nodes).
    if _depth > _MAX_DEPTH or id(value) in _seen:
        return {"__repr__": _scrub_addresses(repr(value)[:200]) + " <cycle/deep>"}, True
    seen = _seen | {id(value)}

    if isinstance(value, (set, frozenset)):  # frozenset is NOT a set subclass
        items, un = [], False
        for v in sorted(value, key=_sortkey):
            s, u = _canon(v, float_tol, seen, _depth + 1)
            items.append(s)
            un = un or u
        return {"__set__": items}, un
    if isinstance(value, (list, tuple)):
        items, un = [], False
        for v in value:
            s, u = _canon(v, float_tol, seen, _depth + 1)
            items.append(s)
            un = un or u
        return items, un
    if isinstance(value, dict):
        d, un = {}, False
        for k in sorted(value.keys(), key=_sortkey):
            s, u = _canon(value[k], float_tol, seen, _depth + 1)
            d[str(k)] = s
            un = un or u
        return d, un
    # Pydantic v2
    try:
        dump = getattr(value, "model_dump", None)
        if callable(dump):
            return _canon(dump(), float_tol, seen, _depth + 1)
    except Exception:  # noqa: BLE001 - fall through to __dict__/repr
        pass
    # Plain objects / dataclasses via __dict__ (only if it carries attributes).
    # vars() raises TypeError without __dict__; a __dict__ PROPERTY may raise
    # anything — all caught, so a hostile object never crashes the comparison.
    try:
        d = dict(vars(value))
        if d:
            return _canon(d, float_tol, seen, _depth + 1)
    except Exception:  # noqa: BLE001
        pass
    # repr fallback, itself defensive: a return value whose __repr__ raises (a
    # partially-initialized real object) must NOT make canonicalize throw — that
    # would misreport a SUCCESSFUL return as an exception (or a spurious divergence).
    try:
        return {"__repr__": _scrub_addresses(repr(value))}, True
    except Exception:  # noqa: BLE001
        return {"__repr__": f"<unreprable {type(value).__name__}>"}, True


@dataclass(frozen=True)
class FieldDelta:
    field_path: str
    kind: str  # value_change | type_change | added | removed | count_change | ordering
    old_repr: str
    new_repr: str


_TAGGED = ("__set__", "__bytes__", "__iso__", "__repr__", "__float__")


def _is_tagged(v: Any) -> bool:
    return isinstance(v, dict) and len(v) == 1 and next(iter(v)) in _TAGGED


def _tag(v: Any) -> str:
    return next(iter(v)) if _is_tagged(v) else ""


def _numequal(a: Any, b: Any, tol: float) -> bool:
    """Numeric equality across int/float (not bool) within relative tolerance."""
    a_num = isinstance(a, (int, float)) and not isinstance(a, bool)
    b_num = isinstance(b, (int, float)) and not isinstance(b, bool)
    if not (a_num and b_num):
        return False
    if math.isnan(a) or math.isnan(b):
        return False
    return math.isclose(a, b, rel_tol=tol, abs_tol=tol)


def diff(
    old: CanonicalValue, new: CanonicalValue, *, float_tol: float = 1e-9
) -> list[FieldDelta]:
    deltas: list[FieldDelta] = []
    _walk(old.shape, new.shape, "", deltas, float_tol)
    return deltas


def _walk(oldv: Any, newv: Any, path: str, out: list[FieldDelta], tol: float) -> None:
    # Tagged scalar wrappers (bytes/iso/repr/float-special)
    if _is_tagged(oldv) or _is_tagged(newv):
        if _tag(oldv) != _tag(newv):
            out.append(FieldDelta(path or "<root>", "type_change", repr(oldv), repr(newv)))
            return
        if oldv != newv:
            out.append(FieldDelta(path or "<root>", "value_change", repr(oldv), repr(newv)))
        return

    # Booleans are a distinct type from int/float.
    old_bool = isinstance(oldv, bool)
    new_bool = isinstance(newv, bool)
    if old_bool or new_bool:
        if not (old_bool and new_bool) or oldv != newv:
            out.append(FieldDelta(path or "<root>", "type_change", repr(oldv), repr(newv)))
        return

    # Both dicts -> recurse by key.
    if isinstance(oldv, dict) and isinstance(newv, dict):
        oldk, newk = set(oldv), set(newv)
        for k in sorted(newk - oldk, key=str):
            out.append(FieldDelta(_join(path, k), "added", "<absent>", repr(newv[k])))
        for k in sorted(oldk - newk, key=str):
            out.append(FieldDelta(_join(path, k), "removed", repr(oldv[k]), "<absent>"))
        for k in sorted(oldk & newk, key=str):
            _walk(oldv[k], newv[k], _join(path, k), out, tol)
        return

    # Both lists -> compare length, then common prefix.
    if isinstance(oldv, list) and isinstance(newv, list):
        if len(oldv) != len(newv):
            out.append(FieldDelta(path or "<root>", "count_change", repr(oldv), repr(newv)))
        for i in range(min(len(oldv), len(newv))):
            _walk(oldv[i], newv[i], f"{path}[{i}]" if path else f"[{i}]", out, tol)
        return

    # Structurally different (dict vs list, scalar vs container, etc).
    if isinstance(oldv, (dict, list)) != isinstance(newv, (dict, list)):
        out.append(FieldDelta(path or "<root>", "type_change", repr(oldv), repr(newv)))
        return

    # Scalars (str, int, float, None, ...). bool already handled above.
    if isinstance(oldv, (int, float)) and isinstance(newv, (int, float)):
        if not _numequal(oldv, newv, tol):
            out.append(FieldDelta(path or "<root>", "value_change", repr(oldv), repr(newv)))
        return
    if type(oldv) is not type(newv):
        out.append(FieldDelta(path or "<root>", "type_change", repr(oldv), repr(newv)))
        return
    if oldv != newv:
        out.append(FieldDelta(path or "<root>", "value_change", repr(oldv), repr(newv)))


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key
