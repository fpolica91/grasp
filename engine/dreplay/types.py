"""Public data types for dreplay.

These types are the contract the canaries exercise and the seam future language
adapters plug into. Only :mod:`dreplay.adapter` is language-specific; everything
downstream (noise / diff / replay / render / fuzzer) operates on
``InvocationResult`` / ``CanonicalValue`` / ``ReplayReport``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class Policy:
    """How one invocation is run. Passed to the adapter on every ``invoke``."""

    egress: Literal["denied", "allowlisted", "full"] = "denied"
    allowlist_hosts: tuple[str, ...] = ()
    # expensive/metered deps to cap (Tier-2 harness.yaml declares these).
    # Shape: {name: {"host": "api.stripe.com", "max_calls": 5}}. max_calls is the
    # GLOBAL budget for the whole check (all variants x branches x self-diff runs),
    # NOT per-invocation; 0 = never call. Enforced even when egress is allowed.
    expensive_deps: dict[str, dict] = field(default_factory=dict)
    # Per-invocation slice of the global budget, injected by the orchestrator
    # before each subprocess: {name: calls still allowed for this check}. The
    # worker caps THIS run at that number; the parent decrements it across runs.
    expensive_remaining: dict[str, int] = field(default_factory=dict)
    # Dotted-callable mocks: {"myapp.payments.charge": <return value>}. The worker
    # patches the callable to return the value, so a metered dep is never actually
    # called — cost bounded to zero regardless of egress. (Mock the team's own dep
    # wrapper; the value is returned as-is, so shape it like the real return.)
    mocks: dict[str, object] = field(default_factory=dict)
    # Active fault plan for THIS invocation: {dep_dotted_name: ["ok","error",...]}.
    # Applied to the matching mock — call i raises the dep's fault error when
    # outcome[i] is "error", else returns the mock value. Empty = no faults.
    fault_plan: dict[str, list] = field(default_factory=dict)
    # Per-dep exception TYPE to raise on an injected "error", as a dotted path
    # ({"billing.charge": "requests.exceptions.ConnectionError"}). Without one the
    # fault is a generic InjectedFault — which a handler catching a NARROW type
    # would not catch, so declaring the real type is required to exercise such code.
    fault_errors: dict[str, str] = field(default_factory=dict)
    # Frozen epoch-seconds injected as time.time(); None = wall clock (noisy).
    # Default None so the noise learner can *see* time-based nondeterminism;
    # the CLI freezes the clock by default for replay (see D6).
    clock: float | None = None
    # Injected RNG seed; None = the code's own RNG (noisy).
    rng_seed: int | None = 0
    repeat_count: int = 1  # self-diff N (old-vs-old)
    timeout_s: float = 30.0
    # Interpreter to run the worker under. None = dreplay's own (sys.executable).
    # Point this at the TARGET repo's venv python so its installed deps import —
    # the in-scope part of "inherit their environment" (D2). dreplay's pure
    # modules still load from the repo root, so a foreign interpreter works.
    python_exe: str | None = None
    # Relative float tolerance for canonical comparison (F2); named in scope.
    float_tol: float = 1e-9


@dataclass(frozen=True)
class ImplSpec:
    """Points at a callable entrypoint. Schema properties map to kwargs."""

    module: str  # importable dotted path
    func: str  # entrypoint name


@dataclass(frozen=True)
class CanonicalValue:
    """A normalized, serializable, comparable representation of any value.

    ``unstructured=True`` means we fell back to ``repr()`` — the consumer must
    trust it less (F3).
    """

    shape: Any
    unstructured: bool = False


@dataclass(frozen=True)
class BoundaryRecord:
    """An intercepted outbound call or a hard stop.

    ``kind`` distinguishes *policy block* (egress denied — actionable config)
    from *real failure* (timeout / connection refused — possibly the bug).
    The payload is what the call *would have* sent — itself diffable (F6).
    """

    kind: Literal["policy_block", "real_failure"]
    target: dict  # {host, method, port} | {command}
    payload: CanonicalValue | None
    reason: str
    downstream_coverage_lost: str
    intercepted_at: Literal["library", "socket", "process", "unknown"] = "library"


@dataclass(frozen=True)
class InvocationResult:
    """Everything observable from one input through one branch.

    Two-tier confidence lives on ``stopped_at_boundary`` and on each
    :class:`Divergence` — never merged (F12).
    """

    return_value: CanonicalValue | None
    exception: dict | None  # {type, message, args_repr} — a real output channel
    mutated_args: dict[str, CanonicalValue]
    unobservable_args: tuple[str, ...]  # args we could NOT snapshot (F5)
    stdout: str
    stderr: str
    logs: list[dict]
    fs_effects: dict[str, str]  # path -> post-run content (sandboxed cwd diff)
    outbound_calls: list[BoundaryRecord]
    tier_confidence: Literal[
        "inherited_env", "declared", "single_run", "static_only"
    ]
    stopped_at_boundary: BoundaryRecord | None  # first hard block
    wall_clock_s: float
    exit_status: int
    # Set when the entrypoint could not even be IMPORTED/RESOLVED (the function
    # never ran) — distinct from an exception the function itself raised. If this
    # is identical on old and new, the run tested NOTHING; reporting "no
    # divergence" would be a false green, so the engine refuses instead.
    entrypoint_error: dict | None = None
    # Allowed (actually-permitted) calls to each expensive dep during THIS run, so
    # the orchestrator can decrement the global budget. {dep_name: count}.
    expensive_calls: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Divergence:
    """One behavioral delta on a surviving (non-noise) field, on one channel."""

    channel: Literal[
        "return", "exception", "mutated_args", "fs", "outbound", "logs", "stdout"
    ]
    field_path: str  # "status" | "items[-1]" | "fs:receipt.txt" | "outbound[0].payload.currency"
    kind: Literal[
        "value_change",
        "type_change",
        "added",
        "removed",
        "ordering",
        "count_change",
        "control_flow",
    ]
    old_repr: str
    new_repr: str
    pervasiveness: tuple[int, int]  # (k inputs diverged, n inputs total)
    confidence: Literal["confirmed", "possible_downstream"]
    reproducing_input: dict
    severity_rank: int  # magnitude proxy: lower = more severe (D4)


@dataclass(frozen=True)
class ScopeStatement:
    """Data-driven honesty statement (F9). Never boilerplate."""

    n_inputs: int
    channels_captured: list[str]
    unobservable_args: list[str]
    masked_fields: list[str]
    boundary_hit: str | None
    trust_boundary: str  # names the egress mechanism + its limit
    containment_level: str  # "kernel_netns" | "python_layer" — how egress is enforced
    text: str  # assembled; includes the verbatim-spirit line


@dataclass(frozen=True)
class ReplayReport:
    branches: tuple[str, str]
    divergences: list[Divergence]
    variant_count: int
    noise_mask: list[str]
    scope: ScopeStatement
    any_refused: bool  # a boundary / refuse event occurred
    containment_level: str = "python_layer"  # egress enforcement actually used
    # True when the fuzz-spam loop was refused because egress containment on this
    # host is python-layer-only (degraded to a single input). Fail-closed default.
    fuzz_refused_for_containment: bool = False
    # Execution tier the run was classified at (D7): inherited_env (Tier 1, tests
    # present) | declared (Tier 2, harness.yaml) | single_run | static_only.
    tier: str = "inherited_env"
    # True when the fuzz-spam loop was refused because the repo offers NO isolation
    # (no tests, no harness.yaml) — degraded to a single run. A feature, not a bug.
    fuzz_refused_for_isolation: bool = False
    # Total allowed calls to each expensive dep across the WHOLE check (capped at
    # its global budget). Surfaced so the reviewer sees real metered-call spend.
    expensive_calls_total: dict[str, int] = field(default_factory=dict)
    # Number of distinct fault plans exercised per input (0 = fault injection off).
    fault_plans_tested: int = 0
    # True when fault injection was requested but REFUSED (quarantined v2 feature:
    # requires explicit acknowledgement that it causes deliberate side-effects).
    fault_injection_refused: bool = False
    # Set when the entrypoint could not be imported/resolved on BOTH refs, so NO
    # behavior was actually exercised. "No divergence" here would be a false green;
    # the report says the run tested nothing and why.
    entrypoint_unresolved: str | None = None
    # Channels whose ENTIRE value is nondeterministic (masked as noise at the root):
    # a real change there could NOT be detected, so a bare "no divergence" would be a
    # false negative. Disclosed loudly instead of implied-clean (principle 3).
    blind_channels: tuple[str, ...] = ()
