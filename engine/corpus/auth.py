"""Corpus: auth / identity domain. User + Session models; authorize() exercises an
auth-check + tenant scoping — a domain where under-show (missing the auth node) or
over-show (plumbing flooding) are the failures that matter."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class User:
    user_id: int
    tenant_id: int
    role: str
    active: bool


@dataclass
class Session:
    token: str
    user_id: int
    tenant_id: int


def _check_role(user: dict, required: str) -> bool:
    # binds model fields (role, active) → business
    return user.get("active") and user.get("role") == required


def _same_tenant(user: dict, resource: dict) -> bool:
    # binds tenant_id (a model field on both) → business
    return user.get("tenant_id") == resource.get("tenant_id")


def authorize(user: dict, resource: dict, required_role: str = "admin") -> dict:
    if not _check_role(user, required_role):
        return {"allowed": False, "reason": "forbidden"}
    if not _same_tenant(user, resource):
        return {"allowed": False, "reason": "cross_tenant"}
    return {"allowed": True, "user_id": user.get("user_id"), "tenant_id": user.get("tenant_id")}
