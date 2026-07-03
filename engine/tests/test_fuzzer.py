"""fuzzer.py — seed-pinned, constraint-respecting variant generation."""
from __future__ import annotations

import os
import tempfile

import jsonschema
import pytest

from dreplay.fuzzer import Fuzzer, persist

_C1 = {
    "type": "object",
    "properties": {
        "order_id": {"type": "string", "minLength": 1},
        "paid": {"type": "boolean"},
    },
    "required": ["order_id", "paid"],
    "additionalProperties": False,
}
_AMOUNT = {
    "type": "object",
    "properties": {"amount": {"type": "number", "minimum": 0}},
    "required": ["amount"],
}
_ITEMS = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {"type": "string"}}},
    "required": ["items"],
}


def test_same_seed_same_variants() -> None:
    a = Fuzzer(_C1, seed=7).variants(12)
    b = Fuzzer(_C1, seed=7).variants(12)
    assert a == b


def test_different_seed_different_variants() -> None:
    a = Fuzzer(_C1, seed=1).variants(12)
    b = Fuzzer(_C1, seed=2).variants(12)
    assert a != b


def test_every_variant_is_schema_valid() -> None:
    vs = Fuzzer(_C1, seed=0).variants(20)
    for v in vs:
        jsonschema.validate(v, _C1)  # raises if invalid (F8)


def test_respects_minimum() -> None:
    for v in Fuzzer(_AMOUNT, seed=0).variants(20):
        assert v["amount"] >= 0


def test_edge_cases_present() -> None:
    # empty array should appear among variants of an array-of-string schema
    vs = Fuzzer(_ITEMS, seed=0).variants(12)
    assert any(v["items"] == [] for v in vs)
    # zero appears for a non-negative number
    vs2 = Fuzzer(_AMOUNT, seed=0).variants(20)
    assert any(v["amount"] == 0 for v in vs2)


def test_const_and_enum() -> None:
    s = {"type": "object", "properties": {"k": {"const": 5}}, "required": ["k"]}
    assert all(v["k"] == 5 for v in Fuzzer(s, seed=0).variants(4))
    e = {"type": "object", "properties": {"c": {"enum": ["a", "b"]}}, "required": ["c"]}
    assert all(v["c"] in ("a", "b") for v in Fuzzer(e, seed=0).variants(8))


def test_persist_roundtrip() -> None:
    vs = Fuzzer(_C1, seed=3).variants(5)
    d = tempfile.mkdtemp()
    path = persist(vs, 3, d)
    assert os.path.exists(path)
    import json

    with open(path) as fh:
        m = json.load(fh)
    assert m["seed"] == 3 and m["variants"] == vs


def test_invalid_generation_would_raise() -> None:
    # sanity: a schema with a minimum the fuzzer must honor; if it didn't,
    # variants() would raise jsonschema.ValidationError.
    s = {"type": "object", "properties": {"n": {"type": "integer", "minimum": 10}}, "required": ["n"]}
    for v in Fuzzer(s, seed=0).variants(20):
        assert v["n"] >= 10
