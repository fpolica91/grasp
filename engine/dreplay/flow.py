"""The flow representation — dreplay's core data model (spec §3).

A :class:`Flow` is an ordered sequence of :class:`Node`\\s captured from ONE real
execution of the entrypoint (Mode A) or one fuzzed input (Mode B). Each node is an
**observed fact** about what happened to a business object as data moved through the
code. The whole model obeys principle #1 (observed, never guessed):

* every :class:`Operand` carries a :class:`Provenance` of ``observed`` / ``declared`` /
  ``unknown`` — and constructing one with any other provenance (e.g. ``"guessed"``)
  **raises**. That is the build-fail guard: a fabricated operand is the one unrecoverable
  failure (§0/§1).
* :meth:`Flow.default_nodes` is the collapsed-by-default view (§4): only
  business-meaningful nodes. The classifier that sets ``Node.business_meaningful`` is
  built in §8.3; until then nodes are created with it set explicitly by the (future)
  instrumentation.

``observe_flow`` is the engine entry. Capturing **interior** node state requires real
instrumentation (``sys.settrace`` / AST / span hooks), NOT input→output capture alone.
Until that lands (§8.2) it is an honest stub: it **raises** rather than synthesize a
flow. A faked flow is exactly the green-light-that-lies failure the tool exists against.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .types import CanonicalValue, ImplSpec

Provenance = Literal["observed", "declared", "unknown"]
NodeKind = Literal[
    "input",
    "controller",
    "auth_check",
    "validation",
    "db_write",
    "db_read",
    "external_call",
    "transform",
    "return",
    "other",
]
Mode = Literal["instant", "fuzz"]

_VALID_PROVENANCE = ("observed", "declared", "unknown")


@dataclass(frozen=True)
class Operand:
    """An adjudicable quantity/state on a node.

    ``value`` is the observed value (canonical), or ``None`` when
    ``provenance == "unknown"`` (the human supplies it). ``derived_from`` documents a
    quantity computed from other observed operands via exact arithmetic (e.g.
    ``"phases × measured_per_phase"``) — still observed, not estimated.
    """

    name: str
    value: Any
    provenance: Provenance
    derived_from: str | None = None

    def __post_init__(self) -> None:
        # Principle #1, enforced in the type system: a guessed operand cannot exist.
        if self.provenance not in _VALID_PROVENANCE:
            raise ValueError(
                f"operand {self.name!r}: provenance must be one of {_VALID_PROVENANCE} "
                f"(got {self.provenance!r}). An estimated/model-inferred operand is the "
                f"one unrecoverable failure — see docs/what-this-is.md §1."
            )


@dataclass(frozen=True)
class BusinessObject:
    """A business entity and the field values bound at this node.

    e.g. ``BusinessObject(name="organization", fields={"owner": CanonicalValue(None)})``.
    """

    name: str
    fields: dict[str, CanonicalValue] = field(default_factory=dict)


@dataclass(frozen=True)
class Node:
    kind: NodeKind
    label: str
    business_objects: tuple[BusinessObject, ...] = ()
    operands: tuple[Operand, ...] = ()
    provenance: Provenance = "observed"  # the node's existence: traced vs declared
    open_question: str | None = None  # neutral, ends in "intended?" — NEVER a verdict
    business_meaningful: bool = False  # classifier output (§4); default view filter
    interior: tuple["Node", ...] = ()  # collapsed plumbing sub-steps (expandable)
    raw_detail: str | None = None  # full captured detail shown on expand


@dataclass(frozen=True)
class Flow:
    entrypoint: str
    mode: Mode
    nodes: tuple[Node, ...]
    seed: int | None = None
    containment_level: str = "python_layer"
    # Mode transparency (the reviewer's [Certain] prerequisite): every run prints
    # which classifier mode it used + vocab count + fallback reason, so the reviewer
    # can tell a genuine clean flow from a vocab=0 blind one.
    classifier_mode: str = "non_vocab"  # "vocab" | "non_vocab"
    vocab_size: int = 0
    fallback_reason: str | None = None

    def default_nodes(self) -> tuple[Node, ...]:
        """The collapsed-by-default view (§4): only business-meaningful nodes."""
        return tuple(n for n in self.nodes if n.business_meaningful)

    def all_operands(self) -> list[Operand]:
        """Every operand across every node (default + interior) — for provenance audit."""
        out: list[Operand] = []
        for n in self.nodes:
            out.extend(n.operands)
            for inner in n.interior:
                out.extend(inner.operands)
        return out


def observe_flow(
    *,
    spec: ImplSpec,
    kwargs: dict,
    mode: Mode = "instant",
    seed: int | None = None,
    python_path: list[str] | None = None,
    business_fields: tuple[str, ...] = (),
    walled: bool = False,
    interpreter: str | None = None,
) -> Flow:
    """Run the entrypoint and capture the observed :class:`Flow`.

    Mode A (``mode="instant"``): one real run, the daily driver. Mode B
    (``mode="fuzz"``): one fuzzed input of a fuzz pass (the orchestrator drives many).
    ``walled=True`` arms the kernel egress wall for that run (Mode B's stance —
    the fuzz orchestrator sets it; instant runs stay real by design).

    ``python_path`` is where the entrypoint's dotted module resolves from (the
    target repo root); defaults to the dreplay repo root. ``business_fields`` widens
    the recognized business-field set (default heuristics ∪ these).

    Delegates to :mod:`dreplay.instrument` (lazy import to avoid a circular
    dependency: instrument imports these types). Interior state is captured via real
    ``sys.settrace`` instrumentation; nothing is synthesized.
    """
    from .instrument import run_flow  # lazy: instrument imports flow types

    return run_flow(spec=spec, kwargs=kwargs, mode=mode, seed=seed,
                    python_path=python_path, business_fields=business_fields,
                    walled=walled, interpreter=interpreter)
