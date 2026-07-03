"""Tier-A gated corpus: diverse business-object modules exercised every gate run.

Copies each corpus module to a temp dir and runs it AS A TARGET (so its declared
models are scanned for the schema-derived vocabulary — exercising vocab mode, not the
denylist fallback). Catches, deterministically: noise explosions (default-node count
over baseline), under-show (a model-binding helper missing from the default view), and
crashes on realistic multi-call business code.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from dreplay.flow import observe_flow
from dreplay.types import ImplSpec

_REPO = Path(__file__).resolve().parent.parent


def _run_in_temp(module_file: str, func: str, kwargs: dict, tmp_path):
    """Copy a corpus module into a temp package and run observe_flow against it (so its
    models are vocab-scanned). Returns the Flow."""
    pkg = tmp_path / "ctarget"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    shutil.copy(_REPO / "corpus" / module_file, pkg / module_file)
    return observe_flow(
        spec=ImplSpec(module="ctarget." + module_file[:-3], func=func),
        kwargs=kwargs, python_path=[str(tmp_path)],
    )


def test_corpus_billing_no_explosion_and_no_undershow(tmp_path) -> None:
    flow = _run_in_temp("billing.py", "compute_invoice",
                        {"customer_id": 7, "items": [{"sku": "A", "quantity": 2, "unit_price": 5}]},
                        tmp_path)
    assert not any(n.label == "instrumentation-error" for n in flow.nodes), "billing crashed"
    # the model fields (unit_price/quantity) must appear SOMEWHERE in the default view
    # (here on the genexpr that iterates the LineItem dicts) — no under-show of fields
    field_names = {o.name for n in flow.default_nodes() for o in n.operands}
    assert {"unit_price", "quantity"} & field_names, (
        f"billing under-show: unit_price/quantity missing from default view ({field_names})"
    )
    # _apply_tax takes a scalar → binds nothing → must collapse (no over-show)
    assert "_apply_tax" not in [n.label for n in flow.default_nodes()]
    # no noise explosion
    assert len(flow.default_nodes()) <= 8, (
        f"billing noise explosion: {len(flow.default_nodes())} default nodes"
    )
    # vocab-derived Invoice fields appear on the return
    ret = [n for n in flow.default_nodes() if n.kind == "return"][0]
    assert any(o.name == "total" for o in ret.operands)


def test_corpus_auth_no_explosion_and_no_undershow(tmp_path) -> None:
    flow = _run_in_temp(
        "auth.py", "authorize",
        {"user": {"user_id": 1, "tenant_id": 5, "role": "admin", "active": True},
         "resource": {"tenant_id": 5}},
        tmp_path,
    )
    assert not any(n.label == "instrumentation-error" for n in flow.nodes), "auth crashed"
    # both helpers bind model fields (role/active, tenant_id) → must show
    assert "_check_role" in [n.label for n in flow.default_nodes()]
    assert "_same_tenant" in [n.label for n in flow.default_nodes()]
    assert len(flow.default_nodes()) <= 8, (
        f"auth noise explosion: {len(flow.default_nodes())} default nodes"
    )
