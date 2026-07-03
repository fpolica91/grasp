"""Tests for dreplay.canonical — value normalization + field-path diff.

This is the comparison core: every captured channel flows through canonicalize(),
and diff() walks two CanonicalValues to emit per-path deltas. Getting float
tolerance, set ordering, and type discrimination right here is what prevents
both false alarms and silent misses downstream.
"""
from __future__ import annotations

import datetime

from dreplay.canonical import diff, canonicalize


# ---------- canonicalize ----------

def test_canonicalize_primitives() -> None:
    assert canonicalize(None).shape is None
    assert canonicalize(True).shape is True
    assert canonicalize(42).shape == 42
    assert canonicalize("x").shape == "x"


def test_canonicalize_floats_special() -> None:
    assert canonicalize(1.5).shape == 1.5
    import math

    assert canonicalize(float("nan")).shape == {"__float__": "nan"}
    assert canonicalize(float("inf")).shape == {"__float__": "inf"}
    assert canonicalize(float("-inf")).shape == {"__float__": "-inf"}


def test_canonicalize_bytes() -> None:
    assert canonicalize(b"ab").shape == {"__bytes__": "6162"}


def test_canonicalize_set_is_order_independent() -> None:
    a = canonicalize({"b", "a"}).shape
    b = canonicalize({"a", "b"}).shape
    assert a == b == {"__set__": ["a", "b"]}


def test_canonicalize_dict_sorts_keys() -> None:
    assert canonicalize({"b": 1, "a": 2}).shape == {"a": 2, "b": 1}


def test_canonicalize_nested() -> None:
    v = canonicalize({"items": [1, {"k": b"\x00"}]})
    assert v.shape == {"items": [1, {"k": {"__bytes__": "00"}}]}
    assert v.unstructured is False


def test_canonicalize_datetime() -> None:
    dt = datetime.datetime(2026, 6, 24, 12, 0, 0)
    assert canonicalize(dt).shape == {"__iso__": "2026-06-24T12:00:00"}


def test_canonicalize_unknown_object_falls_back_unstructured() -> None:
    class Foo:
        def __repr__(self) -> str:
            return "<Foo x>"

    cv = canonicalize(Foo())
    assert cv.unstructured is True
    assert cv.shape == {"__repr__": "<Foo x>"}


def test_canonicalize_object_with_dict() -> None:
    class P:
        def __init__(self) -> None:
            self.a = 1
            self.b = "z"

    assert canonicalize(P()).shape == {"a": 1, "b": "z"}


# ---------- diff ----------

def test_diff_identical_is_empty() -> None:
    assert diff(canonicalize({"a": 1}), canonicalize({"a": 1})) == []


def test_diff_value_change() -> None:
    d = diff(canonicalize({"a": 1}), canonicalize({"a": 2}))
    assert len(d) == 1
    assert d[0].field_path == "a"
    assert d[0].kind == "value_change"
    assert d[0].old_repr == "1" and d[0].new_repr == "2"


def test_diff_type_change() -> None:
    d = diff(canonicalize({"price": 9.99}), canonicalize({"price": "9.99"}))
    assert d[0].kind == "type_change"
    assert d[0].field_path == "price"


def test_diff_bool_vs_int_is_type_change() -> None:
    d = diff(canonicalize({"flag": 1}), canonicalize({"flag": True}))
    assert d[0].kind == "type_change"


def test_diff_int_float_numeric_equal_no_delta() -> None:
    # 2 (int) vs 2.0 (float) — numerically equal -> no divergence (documented default)
    assert diff(canonicalize({"n": 2}), canonicalize({"n": 2.0})) == []


def test_diff_float_within_tolerance_no_delta() -> None:
    assert diff(
        canonicalize({"x": 1.0}),
        canonicalize({"x": 1.0000001}),
        float_tol=1e-6,
    ) == []


def test_diff_float_beyond_tolerance_value_change() -> None:
    d = diff(
        canonicalize({"x": 1.0}),
        canonicalize({"x": 1.5}),
    )
    assert d[0].kind == "value_change"


def test_diff_added_removed_keys() -> None:
    d = diff(canonicalize({"a": 1}), canonicalize({"a": 1, "b": 2}))
    assert d[0].kind == "added" and d[0].field_path == "b"
    d = diff(canonicalize({"a": 1, "b": 2}), canonicalize({"a": 1}))
    assert d[0].kind == "removed" and d[0].field_path == "b"


def test_diff_list_count_change() -> None:
    d = diff(canonicalize({"xs": [1, 2]}), canonicalize({"xs": [1, 2, 3]}))
    assert any(x.kind == "count_change" and x.field_path == "xs" for x in d)


def test_diff_list_element_value_change() -> None:
    d = diff(canonicalize({"xs": [1, 2, 3]}), canonicalize({"xs": [1, 9, 3]}))
    assert d[0].field_path == "xs[1]" and d[0].kind == "value_change"


def test_diff_set_equal_no_delta() -> None:
    assert diff(canonicalize({"s": {1, 2}}), canonicalize({"s": {2, 1}})) == []


def test_diff_set_members_differ_value_change() -> None:
    d = diff(canonicalize({"s": {1, 2}}), canonicalize({"s": {1, 3}}))
    assert d[0].field_path == "s" and d[0].kind == "value_change"


def test_diff_nested_path() -> None:
    old = canonicalize({"data": {"items": [{"id": 1}]}})
    new = canonicalize({"data": {"items": [{"id": 2}]}})
    d = diff(old, new)
    assert d[0].field_path == "data.items[0].id"


# --- real-repo dogfound false positives (packaging.parse_wheel_filename) ---

def test_frozenset_is_order_independent_like_set() -> None:
    """frozenset is NOT a set subclass — without explicit handling it fell back to
    repr() and looked like a divergence on identical code (packaging returns a
    frozenset of Tag objects). Dogfound false positive."""
    assert diff(canonicalize({"t": frozenset({1, 2, 3})}),
                canonicalize({"t": frozenset({3, 1, 2})})) == []


def test_repr_memory_addresses_are_scrubbed() -> None:
    """An object whose repr embeds a memory address (CPython default '<X at 0x..>'
    or a custom '<X @ 140..>') would diverge every process on identical code.
    Addresses are scrubbed to a stable placeholder. Dogfound false positive
    (packaging Tag.__repr__ embeds id(self))."""
    class Tagish:
        def __init__(self, name): self.name = name
        def __repr__(self): return f"<{self.name} @ {id(self)}>"

    a, b = Tagish("cp310"), Tagish("cp310")          # same name, different addresses
    assert a is not b and repr(a) != repr(b)         # genuinely different reprs
    assert diff(canonicalize({"x": a}), canonicalize({"x": b})) == []

    # CPython default-repr objects too
    class Plain: __slots__ = ()
    assert diff(canonicalize({"x": Plain()}), canonicalize({"x": Plain()})) == []


# --- canonicalization must never HANG (dogfound: Enum members self-reference) ---

def test_enum_does_not_hang_and_diffs_by_identity() -> None:
    """An Enum member's __dict__ references its class, which references its members
    -> a reference CYCLE that infinite-recursed canonicalize(). Now handled."""
    import enum

    class Color(enum.Enum):
        RED = 1
        GREEN = 2

    assert diff(canonicalize(Color.RED), canonicalize(Color.RED)) == []
    assert diff(canonicalize(Color.RED), canonicalize(Color.GREEN))[0].kind == "value_change"

    class Size(enum.IntEnum):
        S = 1

    # IntEnum compares as its int value (no divergence vs plain 1)
    assert diff(canonicalize(Size.S), canonicalize(1)) == []


def test_reference_cycle_and_deep_nesting_degrade_not_hang() -> None:
    a: dict = {}
    a["self"] = a                       # genuine cycle
    out = canonicalize(a)               # must return, not hang
    assert "cycle" in str(out.shape)

    d = x = {}                          # 200-deep nesting
    for _ in range(200):
        x["n"] = {}
        x = x["n"]
    canonicalize(d)                     # must return, not blow the stack


def test_hostile_repr_or_dict_does_not_crash_canonicalize() -> None:
    """A SUCCESSFUL return whose __repr__ or __dict__ access raises must not make
    canonicalize() throw — otherwise the worker misreports a successful call as an
    exception (or a spurious one-sided divergence). Dogfound by probing."""
    class BadRepr:
        __slots__ = ()
        def __repr__(self):
            raise ValueError("repr boom")

    class BadVars:
        @property
        def __dict__(self):
            raise RuntimeError("vars boom")

    canonicalize(BadRepr())   # must not raise
    canonicalize(BadVars())   # must not raise
    assert diff(canonicalize(BadRepr()), canonicalize(BadRepr())) == []  # no spurious divergence
