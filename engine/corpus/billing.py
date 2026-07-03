"""Corpus: e-commerce / billing domain. Declares LineItem + Invoice models and a
multi-call entrypoint (compute_invoice) that binds model fields via helper calls —
exercises schema-derived vocabulary + the classifier on business objects."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LineItem:
    sku: str
    quantity: int
    unit_price: float


@dataclass
class Invoice:
    customer_id: int
    items: list
    currency: str
    subtotal: float = 0.0
    tax: float = 0.0
    total: float = 0.0


_TAX_RATE = 0.08


def _subtotal(items: list) -> float:
    # binds model fields (unit_price, quantity) on each LineItem dict → business
    return sum(i.get("unit_price", 0) * i.get("quantity", 1) for i in items)


def _apply_tax(amount: float) -> float:
    # scalar arg only → binds no model field → must collapse (not business)
    return round(amount * (1 + _TAX_RATE), 2)


def compute_invoice(customer_id: int, items: list, currency: str = "USD") -> dict:
    sub = _subtotal(items)
    taxed = _apply_tax(sub)
    return {
        "customer_id": customer_id, "items": items, "currency": currency,
        "subtotal": sub, "tax": round(taxed - sub, 2), "total": taxed,
    }
