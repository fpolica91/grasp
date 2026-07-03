"""Seed-pinned schema fuzzer (BO4 / spec §3) — language-independent.

Emits abstract, schema-VALID input variants that genuinely explore the input
space: deliberate edge cases (empty collections, boundary numerics, negatives,
very long strings, unicode/control chars, null where nullable, present-vs-absent
optionals, nesting) PLUS randomized in-range values, so it is not a small fixed
set cycled by index. Reproducible: same seed + same schema ⇒ same variants
(``random.Random(seed)``). Every variant validates against the schema (F8) before
it leaves :func:`variants` — the fuzzer is incapable of emitting an invalid input
(unless ``include_invalid`` is set for an explicit edge mode).

Relevance guard: when real ``examples`` are supplied, some variants are seeded
from / mutated off them, biasing toward in-distribution inputs the target won't
reject at the door. (Down-ranking of both-refs-rejected divergences lives in the
diff layer.)
"""
from __future__ import annotations

import json
import os
import random
import string
from typing import Any

from . import schema as schema_mod

# A varied character pool: ascii, digits, punctuation, whitespace, unicode, control.
_CHAR_POOL = (
    string.ascii_letters + string.digits + string.punctuation + "  \t\n"
    + "ünîcödéçñßΩ漢字🎉" + "\x00\x01\x1f\x7f"
)
_STRING_EDGES = ["", "a", "0", " ", "hello world", "ünîcödé-🎉", "x" * 256, "line1\nline2", "'\";--"]
_INT_EDGES = [0, 1, -1, 2, -2, 7, 42, 255, 256, -255, 2**31 - 1, -(2**31), 2**53]
_FLOAT_EDGES = [0.0, -0.0, 1.0, -1.0, 0.5, -0.5, 3.141592653589793, 1e-9, 1e9, 1.7976931348623157e308]


class Fuzzer:
    def __init__(self, schema: dict, seed: int = 0, *, examples: list[dict] | None = None,
                 include_invalid: bool = False) -> None:
        self.schema = schema
        self.seed = seed
        self.examples = examples or []
        self.include_invalid = include_invalid

    def variants(self, count: int) -> list[dict]:
        rng = random.Random(self.seed)
        out: list[dict] = []
        attempts = 0
        # The first ~third of variants are edge-biased; the rest randomized. Both
        # are driven by the same seeded rng, so the whole set is reproducible.
        idx = 0
        def _valid(v: Any) -> bool:
            if self.include_invalid:
                return True
            try:
                return schema_mod.is_valid(v, self.schema)
            except RecursionError:  # e.g. a self-referential {"$ref": "#"} schema
                raise ValueError(
                    "schema validation recursed without terminating — a circular "
                    "$ref or similarly self-referential schema is not supported."
                ) from None

        while len(out) < count and attempts < count * 20:
            attempts += 1
            edgey = len(out) < max(1, count // 3)
            # On edge variants, INDEX into the edge sets (don't random-sample) so
            # critical boundary values — 0, min, max, "" — are GUARANTEED to appear
            # within the corpus, not left to chance. (A boundary-at-0 bug is missed
            # if the fuzzer never emits 0.)
            v = self._gen(self.schema, rng, edgey, idx)
            idx += 1
            if _valid(v):
                out.append(v)
        # Guarantee count for pathological-but-satisfiable schemas — but BOUNDED, so
        # an UNSATISFIABLE schema (minLength>maxLength, minimum>maximum, ...) can
        # never spin here forever. If nothing valid can be produced, say so clearly.
        guard = 0
        while len(out) < count and guard < count * 50:
            guard += 1
            v = self._gen(self.schema, rng, True, idx)
            idx += 1
            if _valid(v):
                out.append(v)
        if not out and count > 0:
            raise ValueError(
                "could not generate any input satisfying the schema — check for "
                "unsatisfiable constraints (e.g. minLength>maxLength, minimum>maximum) "
                "or unsupported features ($ref)."
            )
        return out

    # ---- generation ----
    def _gen(self, schema: dict, rng: random.Random, edgey: bool, idx: int = 0) -> Any:
        if "const" in schema:
            return schema["const"]
        if "enum" in schema:
            return rng.choice(schema["enum"])

        t = schema.get("type")
        if isinstance(t, list):
            choices = [x for x in t if x != "null"] or ["null"]
            t = "null" if ("null" in t and rng.random() < 0.2) else rng.choice(choices)
        elif t is None:  # untyped schema: pick a type to explore
            t = rng.choice(["string", "integer", "number", "boolean", "array", "object"])

        if t == "string":
            return self._gen_string(schema, rng, edgey, idx)
        if t == "integer":
            return self._gen_int(schema, rng, edgey, idx)
        if t == "number":
            return self._gen_number(schema, rng, edgey, idx)
        if t == "boolean":
            return [True, False][idx % 2] if edgey else rng.choice([True, False])
        if t == "array":
            return self._gen_array(schema, rng, edgey, idx)
        if t == "null":
            return None
        if t == "object":
            return self._gen_object(schema, rng, edgey, idx)
        return None

    def _gen_object(self, schema: dict, rng: random.Random, edgey: bool, idx: int) -> dict:
        props = schema.get("properties", {})
        required = schema.get("required", list(props))
        result: dict[str, Any] = {}
        for name in required:
            result[name] = self._field_value(name, props.get(name, {}), rng, edgey, idx)
        for name, sub in props.items():  # present-vs-absent optionals is an axis too
            if name not in result and rng.random() < (0.3 if edgey else 0.6):
                result[name] = self._field_value(name, sub, rng, edgey, idx)
        return result

    def _field_value(self, name: str, sub: dict, rng: random.Random, edgey: bool, idx: int) -> Any:
        # Relevance bias: sometimes reuse / mutate a real example's value for this field.
        ex_vals = [e[name] for e in self.examples if isinstance(e, dict) and name in e]
        if ex_vals and not edgey and rng.random() < 0.5:
            return self._mutate(rng.choice(ex_vals), rng)
        return self._gen(sub, rng, edgey, idx)

    def _mutate(self, val: Any, rng: random.Random) -> Any:
        if isinstance(val, str) and val and rng.random() < 0.5:
            j = rng.randrange(len(val))
            return val[:j] + rng.choice(_CHAR_POOL) + val[j:]
        if isinstance(val, bool):
            return val
        if isinstance(val, int) and rng.random() < 0.5:
            return val + rng.choice([-1, 1, 10, -10])
        return val

    def _gen_string(self, schema: dict, rng: random.Random, edgey: bool, idx: int = 0) -> str:
        minlen = schema.get("minLength", 0)
        maxlen = schema.get("maxLength")
        if edgey:
            s = _STRING_EDGES[idx % len(_STRING_EDGES)]  # cycle edges -> all guaranteed
        else:
            hi = maxlen if maxlen is not None else 24
            n = rng.randint(minlen, max(minlen, min(hi, 40)))
            s = "".join(rng.choice(_CHAR_POOL) for _ in range(n))
        if len(s) < minlen:
            s = s + "x" * (minlen - len(s))
        if maxlen is not None and len(s) > maxlen:
            s = s[:maxlen]
        return s

    def _gen_int(self, schema: dict, rng: random.Random, edgey: bool, idx: int = 0) -> int:
        mn, mx = schema.get("minimum"), schema.get("maximum")
        if edgey:
            # Lead with the most critical boundaries so they land in the few edge
            # variants; dedup preserves order.
            ordered = [0, mn, mx, (mn + 1) if mn is not None else None,
                       (mx - 1) if mx is not None else None, *_INT_EDGES]
            cands = list(dict.fromkeys(
                int(c) for c in ordered if c is not None and self._in(c, mn, mx)))
            if cands:
                return cands[idx % len(cands)]  # cycle -> 0/min/max guaranteed
        lo = int(mn) if mn is not None else -(2**31)
        hi = int(mx) if mx is not None else 2**31
        if lo > hi:  # reversed bounds (unsatisfiable) — don't crash randint; the
            lo, hi = hi, lo  # value is is_valid-filtered out, generation continues
        return rng.randint(lo, hi)

    def _gen_number(self, schema: dict, rng: random.Random, edgey: bool, idx: int = 0) -> float:
        mn, mx = schema.get("minimum"), schema.get("maximum")
        if edgey:
            cands = [float(c) for c in (_FLOAT_EDGES + _INT_EDGES + [mn, mx])
                     if c is not None and self._in(c, mn, mx)]
            if cands:
                return cands[idx % len(cands)]
        lo = float(mn) if mn is not None else -1e6
        hi = float(mx) if mx is not None else 1e6
        if lo > hi:  # reversed bounds — value is filtered by is_valid
            lo, hi = hi, lo
        return rng.uniform(lo, hi)

    def _gen_array(self, schema: dict, rng: random.Random, edgey: bool, idx: int = 0) -> list:
        items = schema.get("items", {"type": "string"})
        minitems = schema.get("minItems", 0)
        maxitems = schema.get("maxItems")
        if edgey:
            n = [0, 1, 3][idx % 3]  # empty / single / several — all guaranteed
        else:
            hi = maxitems if maxitems is not None else 5
            n = rng.randint(minitems, max(minitems, min(hi, 6)))
        n = max(n, minitems)
        if maxitems is not None:
            n = min(n, maxitems)
        return [self._gen(items, rng, edgey, idx) for _ in range(n)]

    @staticmethod
    def _in(c, mn, mx) -> bool:
        return (mn is None or c >= mn) and (mx is None or c <= mx)


def persist(variants: list[dict], seed: int, dest_dir: str) -> str:
    """Write a corpus manifest (materialized inputs + seed) for reproducibility (F11)."""
    os.makedirs(dest_dir, exist_ok=True)
    manifest = {"seed": seed, "count": len(variants), "variants": variants}
    path = os.path.join(dest_dir, "corpus.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    return path
