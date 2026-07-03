"""Schema ingestion breadth (prompt §1): .jsonl corpora, the real example used by
the single-run floor, and Pydantic introspection."""
from __future__ import annotations

import os
import sys
import tempfile

from dreplay import schema as schema_mod


def _write(name: str, text: str) -> str:
    d = tempfile.mkdtemp()
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)
    return p


def test_jsonl_infers_schema_and_validates_examples() -> None:
    path = _write(
        "inputs.jsonl",
        '{"n": 1, "label": "a", "paid": true}\n{"n": 2, "label": "b", "paid": false}\n',
    )
    schema = schema_mod.load(path)
    assert schema["type"] == "object"
    assert schema["properties"]["n"]["type"] == "integer"
    assert schema["properties"]["label"]["type"] == "string"
    assert schema["properties"]["paid"]["type"] == "boolean"  # not "integer"
    assert set(schema["required"]) == {"n", "label", "paid"}
    # the records used to infer it must validate against it
    for rec in schema_mod.load_jsonl(path):
        assert schema_mod.is_valid(rec, schema)


def test_first_example_is_the_single_run_input() -> None:
    path = _write("inputs.jsonl", '{"n": 42}\n{"n": 7}\n')
    assert schema_mod.first_example(path) == {"n": 42}
    # a .json schema has no implicit example
    jpath = _write("s.json", '{"type":"object","properties":{"n":{"type":"integer"}}}')
    assert schema_mod.first_example(jpath) is None


def test_required_is_intersection_across_records() -> None:
    path = _write("inputs.jsonl", '{"a": 1, "b": 2}\n{"a": 9}\n')
    schema = schema_mod.load(path)
    assert schema["required"] == ["a"]  # b missing from second record


def test_from_pydantic_introspects_model_json_schema() -> None:
    # A stand-in model exposing the pydantic v2 API, so this runs without pydantic.
    import types

    mod = types.ModuleType("fake_models")
    SCHEMA = {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]}

    class Order:
        @staticmethod
        def model_json_schema():
            return SCHEMA

    mod.Order = Order
    sys.modules["fake_models"] = mod
    try:
        assert schema_mod.from_pydantic("fake_models.Order") == SCHEMA
    finally:
        del sys.modules["fake_models"]
