"""Flow-canary scenarios — real, minimal business-logic functions.

The (future) interior instrumentation traces an execution of one of these into an
observed :class:`~dreplay.flow.Flow`. Each maps to a canary in ``test_flow_canaries``:

* ``create_organization`` → FC1 (org created with ``owner=NULL`` — a business rule
  only the human knows: an org MUST have an owner).
* ``write_record``        → FC2 (a write path where the auth-check is NOT executed).
* ``run_migration``       → FC3 (phases × concurrency × measured duration vs a
  configured timeout — operands + an open question, never a verdict).
* ``compute_a`` / ``compute_b`` → FC4 (a no-op refactor: identical observable
  behavior must yield an identical DEFAULT flow).

Kept dependency-free and tiny so the canary suite stays fast.
"""
from __future__ import annotations

# ---- FC1: org created with owner=NULL -----------------------------------------
def create_organization(name: str, owner_id=None) -> dict:
    """Business rule (human knows it): an org MUST have an owner. This binding
    owner=NULL is the adjudicable operand the instrument must surface."""
    org = {"name": name, "owner": owner_id, "status": "active"}
    _save(org)
    return org


def _save(record: dict) -> None:
    record["saved"] = True  # the db-write


# ---- FC2: a write path where auth is NOT executed -----------------------------
def _auth(token):
    return token == "valid"


def write_record(record: dict, skip_auth: bool = False) -> dict:
    if not skip_auth:
        _auth(record.get("token"))  # skipped on this path → auth not executed
    record["saved"] = True  # the write happens anyway
    return record


# ---- FC3: timeout math --------------------------------------------------------
PHASES = 8
CONCURRENCY = 3
PER_PHASE_SECONDS = 0.05  # tiny so the canary is fast; the math is the point
CONFIGURED_TIMEOUT_SECONDS = 120


def run_migration() -> dict:
    import concurrent.futures
    import time

    def _phase(i):
        time.sleep(PER_PHASE_SECONDS)
        return i

    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        list(ex.map(_phase, range(PHASES)))
    return {"phases": PHASES, "timeout": CONFIGURED_TIMEOUT_SECONDS}


# ---- FC4: a no-op refactor (identical behavior, possibly different plumbing) ---
def compute_a(x: int) -> dict:
    return {"v": x + 1}


def compute_b(x: int) -> dict:
    return {"v": _inc(x)}  # extra plumbing, same observable behavior


def _inc(x: int) -> int:
    return x + 1


# ---- Mode B: behavior that VARIES by input (auth-bypass / edge-state class) ----
def authenticate(token: str) -> dict:
    """Returns a status that depends on the input — the kind of claim Mode B
    surfaces by varying inputs the author may not have hit."""
    return {"status": "authenticated" if token else "denied"}


# ---- datetime freeze + business-field widening (limitation-closure coverage) ----
def now_ts() -> dict:
    import datetime

    return {"t": datetime.datetime.utcnow().timestamp()}


def _audit(record: dict) -> None:
    _ = record.get("entitlement")  # touches a NON-default business field


def process(record: dict) -> dict:
    _audit(record)
    return record


# ---- FC6/FC7/FC8: inverted-classifier canaries (default-show, denylist-seeded) ----
def _check_entitlement(record: dict) -> dict:
    return {"entitlement": record.get("entitlement")}


def grant(record: dict) -> dict:
    # _check_entitlement binds a NON-default business field ('entitlement'). Under the
    # old allowlist this was a silent MISS; under the inverted classifier it shows.
    _check_entitlement(record)
    return {"entitlement": record.get("entitlement")}


def _to_dict(record: dict) -> dict:
    # Conversion verb ('to_dict') that binds business-shaped fields (amount/status).
    # It must STILL collapse — noise control under the inversion.
    return {"amount": record.get("amount"), "status": record.get("status")}


def serialize_order(order: dict) -> dict:
    return _to_dict(order)


def _tally(order: dict) -> dict:
    return {"amount": order.get("amount"), "currency": order.get("currency")}


def checkout_a(order: dict) -> dict:
    _tally(order)
    return {"ok": True}


def _sum(order: dict) -> dict:  # renamed _tally — same business binding
    return {"amount": order.get("amount"), "currency": order.get("currency")}


def checkout_b(order: dict) -> dict:
    _sum(order)
    return {"ok": True}
