"""JSON Schema loading + validation (BO4).

The fuzzer generates variants; this module *proves* every variant is
schema-valid (F8) via ``jsonschema``. A generated input that the entrypoint
rejects at its own validation is NOT skipped — the rejection is itself an output
that gets diffed.

Ingestion accepts what teams actually have (prompt §1, "schema.jsonl or
equivalent"): a ``.json`` JSON Schema, a ``.jsonl`` corpus of example inputs (we
infer a schema from them, and the first record is the real example used for the
single-run floor), or a Pydantic model (introspected to JSON Schema).
"""
from __future__ import annotations

import importlib
import json

import jsonschema


def load(path: str) -> dict:
    """Load a JSON Schema from ``.json`` directly, or infer one from a ``.jsonl``
    corpus of example inputs."""
    if path.endswith(".jsonl"):
        return infer_schema(load_jsonl(path))
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_jsonl(path: str) -> list[dict]:
    """Read newline-delimited JSON records (blank lines ignored)."""
    out: list[dict] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def infer_schema(records: list[dict]) -> dict:
    """Infer a JSON Schema (object) from example records: property types from the
    first record; a property is required iff present in every record."""
    if not records:
        raise ValueError("cannot infer a schema from an empty .jsonl corpus")
    bad = next((r for r in records if not isinstance(r, dict)), None)
    if bad is not None:
        raise ValueError(
            f"each example must be a JSON object mapping argument names to values, got "
            f"{type(bad).__name__}: {bad!r}. A function taking a single positional arg "
            f'still needs a named row, e.g. {{"text": "hello"}}, not a bare value.'
        )
    required = set(records[0])
    for r in records:
        required &= set(r)
    props = {k: {"type": _json_type(v)} for k, v in records[0].items()}
    return {
        "type": "object",
        "properties": props,
        "required": sorted(required),
        "additionalProperties": False,
    }


def _json_type(v) -> str:
    if isinstance(v, bool):  # bool is an int subclass — check first
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return "null"


def examples(path: str) -> list[dict]:
    """All real example inputs from a ``.jsonl`` corpus (else empty). These are
    REPLAYED as part of the corpus — representative inputs are the highest-value
    cases, so a "no divergence" must mean they were actually run, not just used to
    infer the schema."""
    if path and path.endswith(".jsonl"):
        return load_jsonl(path)
    return []


def first_example(path: str) -> dict | None:
    """The first real example input (else None). Used as the single-run floor."""
    recs = examples(path)
    return recs[0] if recs else None


def from_pydantic(dotted: str) -> dict:
    """JSON Schema from a Pydantic model given as ``module.Model``.

    Supports pydantic v2 (``model_json_schema``) and v1 (``schema``); anything
    exposing one of those works, so it's testable without pydantic installed.
    """
    mod_name, _, cls = dotted.rpartition(".")
    if not mod_name:
        raise ValueError(f"--pydantic must be 'module.Model', got {dotted!r}")
    model = getattr(importlib.import_module(mod_name), cls)
    if hasattr(model, "model_json_schema"):
        return model.model_json_schema()
    if hasattr(model, "schema"):
        return model.schema()
    raise TypeError(f"{dotted} is not a Pydantic model (no model_json_schema/schema)")


def validate(instance: dict, schema: dict) -> None:
    """Raise :class:`jsonschema.ValidationError` if ``instance`` is invalid."""
    jsonschema.validate(instance=instance, schema=schema)


def is_valid(instance: dict, schema: dict) -> bool:
    try:
        validate(instance, schema)
        return True
    except jsonschema.ValidationError:
        return False
