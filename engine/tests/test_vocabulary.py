"""Schema-derived vocabulary: the classifier reads business fields from the repo's
OWN declared models instead of name-guessing. Tested deterministically against a
synthetic repo with a dataclass model (stdlib, always available)."""
from __future__ import annotations

import os
import sys
import textwrap

import pytest

from dreplay.flow import observe_flow
from dreplay.types import ImplSpec
from dreplay.vocabulary import derive_vocabulary


def _make_repo(path: str) -> str:
    pkg = os.path.join(path, "vrepo")
    os.makedirs(pkg, exist_ok=True)
    open(os.path.join(pkg, "__init__.py"), "w").close()
    with open(os.path.join(pkg, "models.py"), "w") as fh:
        fh.write(textwrap.dedent("""\
            from dataclasses import dataclass

            @dataclass
            class Order:
                total: float
                currency: str
                customer_id: int
        """))
    with open(os.path.join(pkg, "svc.py"), "w") as fh:
        fh.write(textwrap.dedent("""\
            def _compute(order):
                # receives the business object (order) → binds MODEL fields → shows
                return {"total": order.get("total")}

            def _meta(ctx):
                # receives a NON-model dict (ctx={x:..}); 'x' is not in the vocab and
                # _meta binds no model field → must collapse under vocab mode
                return {"rendered": ctx.get("x")}

            def price(order):
                _compute(order)
                _meta({"x": 1})
                return {"total": order.get("total"), "currency": order.get("currency")}
        """))
    return path


def test_derive_vocabulary_reads_model_fields(tmp_path) -> None:
    _make_repo(str(tmp_path))
    vocab = derive_vocabulary([str(tmp_path)])
    assert {"total", "currency", "customer_id"} <= vocab, (
        f"vocab must include the Order dataclass fields; got {sorted(vocab)}"
    )


def test_derive_vocabulary_reads_slots_classes(tmp_path) -> None:
    """Hand-rolled __slots__ classes (like prices repo's Money/TaxedMoney) must be
    introspected — they declare fields via __slots__, not dataclass/pydantic."""
    pkg = tmp_path / "slottest"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "models.py").write_text(
        "class Money:\n"
        "    __slots__ = ('amount', 'currency')\n"
        "    def __init__(self, amount, currency):\n"
        "        self.amount = amount\n"
        "        self.currency = currency\n"
    )
    vocab = derive_vocabulary([str(tmp_path)])
    assert {"amount", "currency"} <= vocab, (
        f"__slots__ fields must be in vocab; got {sorted(vocab)}"
    )


def test_derive_vocabulary_reads_plain_class_init(tmp_path) -> None:
    """Plain classes (no dataclass/pydantic/slots) with __init__ params contribute
    their params to the vocabulary — catches infra code like Allocation(gpu_count, ...).
    The reviewer's 'the one that will bite on your repos.'"""
    pkg = tmp_path / "plaintest"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "models.py").write_text(
        "class Allocation:\n"
        "    def __init__(self, gpu_count, memory_gb, cpu_cores):\n"
        "        self.gpu_count = gpu_count\n"
        "        self.memory_gb = memory_gb\n"
        "        self.cpu_cores = cpu_cores\n"
    )
    vocab = derive_vocabulary([str(tmp_path)])
    assert {"gpu_count", "memory_gb", "cpu_cores"} <= vocab, (
        f"plain class __init__ params must be in vocab; got {sorted(vocab)}"
    )


def test_vocab_mode_shows_model_field_collapses_non_model(tmp_path) -> None:
    _make_repo(str(tmp_path))
    flow = observe_flow(
        spec=ImplSpec(module="vrepo.svc", func="price"),
        kwargs={"order": {"total": 10, "currency": "USD"}},
        python_path=[str(tmp_path)],
    )
    assert "_compute" in [n.label for n in flow.default_nodes()], (
        "vocab mode: _compute (binds model field 'total' via the order arg) must show"
    )
    assert "_meta" not in [n.label for n in flow.default_nodes()], (
        "vocab mode: _meta (binds only non-model field 'x') must collapse"
    )
    # the return surfaces the model fields
    ret = [n for n in flow.default_nodes() if n.kind == "return"][0]
    assert any(o.name == "total" for o in ret.operands)
