"""Mode B — the fuzz pass (spec §2/§8.6): the deeper check before an MR.

Runs the flow over seed-pinned, schema-fuzzed inputs (incl. auth-state variation)
and surfaces the business operands/states that **varied** across inputs — the
claims that only appear under inputs the author didn't hit (the auth-bypass and
edge-state class). Reuses the existing fuzzer; each input is one
:func:`~dreplay.instrument.run_flow`.

Unlike Mode A (instant), the fuzz pass runs **walled by default**
(docs/what-this-is.md §safety): fuzzing multiplies side-effects ×N variants,
which is exactly the runaway the kernel egress wall prevents. The wall denies
NETWORK egress only — filesystem/local side-effects and the real environment
stay real. On a host with no kernel containment (seccomp/netns) the pass
**refuses** (:class:`FuzzRefusal`) rather than run N unwalled executions
silently; ``egress="full"`` (CLI: ``--allow-egress``) is the explicit opt-in
to fuzz for real.

Like Mode A it never judges: it lays the varying operands + their reproducing
inputs on the table and ends in an open question.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Literal

from . import containment
from .flow import Flow, observe_flow
from .fuzzer import Fuzzer
from .types import ImplSpec

_KERNEL_LEVELS = ("seccomp", "kernel_netns")


class FuzzRefusal(RuntimeError):
    """Walled fuzz was requested but this host offers no kernel egress wall."""


@dataclass
class FuzzReport:
    spec: ImplSpec
    variant_count: int
    seed: int
    flows: list[Flow]
    # (kind, label, operand_name) -> {repr(value): (value, reproducing_input)}
    # keyed by repr so unhashable observed values (dicts/lists) cannot crash the scan
    varied: dict[tuple[str, str, str], dict]
    # transparency: how the pass actually ran (walled kernel level vs full/real)
    egress: str = "walled"  # "walled" | "full"
    containment_level: str = "none"
    # variants whose run could not be observed at all (instrumentation-error):
    # [(input, message)]. These are gaps, NOT evidence of stability.
    errors: list = field(default_factory=list)
    # observed raises: one entry per raising variant, carrying the reproducing
    # input and the message — the same reproducibility contract as varied values.
    # [{"type", "message", "input"}]
    raises: list = field(default_factory=list)
    # classifier mode-transparency (same contract as instant/diff): captured from
    # the observed flows so a vocab=0 blind pass is distinguishable from a real one.
    classifier_mode: str = "non_vocab"
    vocab_size: int = 0
    fallback_reason: str | None = None

    def raised(self) -> dict[str, int]:
        """Observed raises across variants: {exception_type: count} — observed facts."""
        out: dict[str, int] = {}
        for r in self.raises:
            t = str(r.get("type", "?"))
            out[t] = out.get(t, 0) + 1
        return out


def fuzz_flow(
    *,
    spec: ImplSpec,
    schema: dict,
    variant_count: int = 8,
    seed: int = 0,
    python_path: list[str] | None = None,
    egress: Literal["walled", "full"] = "walled",
) -> FuzzReport:
    walled = egress == "walled"
    level = "none"
    if walled:
        level = containment.detect().level
        if level not in _KERNEL_LEVELS:
            raise FuzzRefusal(
                "no kernel egress containment on this host (strongest boundary: "
                f"{level}). The fuzz pass multiplies side-effects ×{variant_count} "
                "variants, so it refuses to run unwalled by default. Pass "
                'egress="full" (CLI: --allow-egress) to fuzz FOR REAL, or install '
                "libseccomp / enable `unshare -n`."
            )
    variants = Fuzzer(schema, seed).variants(variant_count)
    flows = [
        observe_flow(spec=spec, kwargs=v, mode="fuzz", seed=seed,
                     python_path=python_path, walled=walled)
        for v in variants
    ]
    seen: dict[tuple[str, str, str], dict] = {}
    errors: list = []
    raises: list = []
    for v, flow in zip(variants, flows):
        err = next(
            (o.value for n in flow.nodes if n.label == "instrumentation-error"
             for o in n.operands if o.name == "error"),
            None,
        )
        if err is not None:
            errors.append((v, err))  # this variant never ran — a gap, not data
            continue
        for n in flow.nodes:
            if n.kind == "input":
                continue  # the input node's operands ARE the inputs we varied —
                # reporting them as "varied" is tautological noise, not a claim.
            if n.kind == "other" and n.label == "thrown-error":
                # A raise is an observed fact, but its MESSAGE often embeds the
                # random fuzzed input (e.g. "'xyz' is not a valid key") — keying
                # varied on it manufactures spurious variation. Capture the raise
                # separately (with its reproducing input) and skip its operands.
                raises.append({
                    "type": next((o.value for o in n.operands if o.name == "type"), "?"),
                    "message": next((o.value for o in n.operands if o.name == "message"), ""),
                    "input": v,
                })
                continue
            for o in n.operands:
                key = (n.kind, n.label, o.name)
                seen.setdefault(key, {})
                vkey = repr(o.value)
                if vkey not in seen[key]:
                    seen[key][vkey] = (o.value, v)
    varied = {k: vals for k, vals in seen.items() if len(vals) > 1}
    # Mode transparency: read the classifier facts off the first OBSERVED flow
    # (all variants share the target, so these are identical; error flows carry a
    # "run not observed" reason we do not want to surface as the pass's mode).
    observed = next((f for i, f in enumerate(flows)
                     if variants[i] not in [e[0] for e in errors]), None)
    cm = observed.classifier_mode if observed else "non_vocab"
    vs = observed.vocab_size if observed else 0
    fr = observed.fallback_reason if observed else None
    return FuzzReport(spec=spec, variant_count=len(variants), seed=seed, flows=flows,
                      varied=varied, egress=egress, containment_level=level,
                      errors=errors, raises=raises,
                      classifier_mode=cm, vocab_size=vs, fallback_reason=fr)


def render_fuzz(report: FuzzReport) -> str:
    ran = report.variant_count - len(report.errors)
    wall = (
        f"egress wall: {report.containment_level} (kernel; network denied)"
        if report.egress == "walled"
        else "egress: FULL — variants ran for real (--allow-egress)"
    )
    lines = [
        f"fuzz: {report.spec.module}.{report.spec.func}   "
        f"{report.variant_count} inputs (seed {report.seed})   {wall}",
        # mode transparency (same contract as instant/diff): a vocab=0 blind pass
        # must be distinguishable from a genuinely clean one.
        f"classifier: {report.classifier_mode}   vocab: {report.vocab_size}"
        + (f"   fallback: {report.fallback_reason}" if report.fallback_reason else ""),
    ]
    if report.raises:
        counts = ", ".join(f"{t} ×{c}" for t, c in sorted(report.raised().items()))
        lines.append(f"observed raises across variants ({len(report.raises)}): {counts}")
        # carry the message + a reproducing input — same contract as varied values
        shown: set = set()
        for r in report.raises:
            k = (r["type"], r["message"])
            if k in shown:
                continue
            shown.add(k)
            lines.append(
                f"    {r['type']}: {r['message']!r} <- reproduce: "
                f"{json.dumps(r['input'], default=repr)}"
            )

    if report.errors:
        lines.append(
            f"{len(report.errors)}/{report.variant_count} variant(s) could NOT be "
            "observed (instrumentation-error) — no claim is made about them:"
        )
        for v, msg in report.errors[:5]:
            lines.append(f"    input {json.dumps(v, default=repr)}: {msg}")
        if len(report.errors) > 5:
            lines.append(f"    ... and {len(report.errors) - 5} more")

    if not report.varied:
        lines.append("")
        n_ret = ran - len(report.raises)  # variants that returned (didn't raise)
        if ran == 0:
            lines.append("0 variants ran — nothing was observed, so no claim is made.")
        elif n_ret == 0:
            # every observed variant RAISED — the opposite of stable. Never
            # imply stability over an all-raising pass (principle #3 honesty).
            lines.append(
                f"No variant returned — all {ran} observed input(s) raised (above). "
                "No stability claim is made."
            )
        else:
            lines.append(
                f"No business operand varied across the {n_ret} returning input(s) "
                + (f"({len(report.raises)} other input(s) raised, above). "
                   if report.raises else "(the flow was stable). ")
                + "This does not test inputs outside the supplied schema, timing, or concurrency."
            )
        return "\n".join(lines)

    lines.append("")
    lines.append(
        f"{len(report.varied)} business operand(s) VARIED across inputs — "
        "claims that only appear on some inputs:"
    )
    for (kind, label, opname), vals in report.varied.items():
        lines.append(f"  {kind}/{label}/{opname}:")
        for value, repro in vals.values():
            lines.append(f"    {value!r:<22} <- reproduce: {json.dumps(repro, default=repr)}")
    lines.append("")
    lines.append("open questions (you adjudicate — no verdicts):")
    for (_, _, opname), vals in report.varied.items():
        vs = [value for value, _repro in vals.values()]
        a, b = vs[0], vs[1] if len(vs) > 1 else vs[0]
        lines.append(f"  ? {opname} moved between {a!r} and {b!r} depending on the input — intended?")
    return "\n".join(lines)


def to_fuzz_json(report: FuzzReport) -> str:
    """Structured fuzz artifact (mirrors render_fuzz; adds nothing, judges nothing)."""
    doc = {
        "entrypoint": f"{report.spec.module}.{report.spec.func}",
        "mode": "fuzz",
        "variant_count": report.variant_count,
        "seed": report.seed,
        "egress": report.egress,
        "containment_level": report.containment_level,
        # mode transparency (same keys as the instant/diff JSON artifact)
        "classifier_mode": report.classifier_mode,
        "vocab_size": report.vocab_size,
        "fallback_reason": report.fallback_reason,
        "ran": report.variant_count - len(report.errors),
        "raised": report.raised(),
        # full raise facts with reproducing input (not just type+count)
        "raises": [
            {"type": r["type"], "message": r["message"], "reproduce_with": r["input"]}
            for r in report.raises
        ],
        "errors": [{"input": v, "error": m} for v, m in report.errors],
        "varied": [
            {
                "kind": kind, "label": label, "operand": opname,
                "values": [
                    {"value": value, "reproduce_with": repro}
                    for value, repro in vals.values()
                ],
            }
            for (kind, label, opname), vals in report.varied.items()
        ],
    }
    return json.dumps(doc, indent=2, default=repr)
