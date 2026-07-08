# grasp spec v2 — the behavior-model post-editor

> Status: IMPLEMENTED, all four phases, as of 2026-07-07. Examples are checked as report
> rows; coverage gaps in compiled rules are named in the tool result (the structural half
> of "the model drives"); report ordering is deterministic. Validated headlessly via
> `npm run validate` (17 assertions against the real registry) plus the turn-path harness.
> Scenario GENERATION quality remains agent-side by design (grasp generates nothing).
> Sole remaining item: pixel sign-off via the in-app harness after one app restart.
> v1 made behavior observable. v2 makes judgment durable.

## 0. Why the overhaul

v1's loop is post-hoc and amnesiac: prose intent goes in, the agent edits, grasp observes,
and **every** observation ends in a question to the human. Nothing the human has ever
adjudicated is remembered, so the human re-judges the same behaviors forever. The apparatus
grew heavy (traces, harnesses, lineage) because the call tree was the front door, when for
review the call tree is the microscope — the thing you reach for when a behavior surprises
you, not the thing you read every day.

v2 adds the missing front half of the drive train: a **standing behavior model** that steers
generation before the edit and gates acceptance after it. The economics of "— intended?"
invert: covered behavior conforms silently or violates loudly; only **novel** behavior asks.

One thing is explicitly rejected from the source material that inspired this revision: the
machine never asserts. No "proven", no "impossible", no "pass". Where v2 says a rule was
*violated*, the judgment being cited was pre-supplied by the human at ratification time —
grasp still only reports observations against declared intent.

## 1. The objects (ontology)

Every artifact in the system is one of these. Nothing else exists.

### 1.1 The Behavior Model — `.grasp/model.yaml` (NEW; the center of v2)

OWNERSHIP (decided 2026-07-07): the model lives at the OWNING REPO's root — the nearest
git root — never at a workspace root that merely contains repos. grasp resolves the owner
by walking up from the file it was handed; a container workspace owns nothing and grasp
refuses to read or write models there.

The durable, git-tracked statement of what the human requires of this codebase. Content is
the contract; YAML is merely the chosen notation (structured, diffable, mergeable — the
format is a decision, not a dogma).

```yaml
grasp_model_version: 1
feature: tasks
states:
  task: [active, completed, deleted]
rules:
  - id: R1
    text: only the owner may edit a task
    origin: authored            # authored | ratified
    check:                      # the checkable compilation of the rule (see 6.2)
      scenario: edit_task
      where:  { op: cmpf, path: actor.id, rel: '!=', other: task.owner_id }
      expect: { status: rejected }
  - id: R2
    text: a deleted task can never be edited
    origin: ratified
    ratified: 2026-07-07
    evidence: fuzz 2026-07-07, 40 cases, 0 counterexamples at ratification
    check: { scenario: edit_task, where: { op: cmp, path: task.state, rel: '==', value: deleted }, expect: { status: rejected } }
examples:
  - label: owner edits own active task
    scenario: edit_task
    input: { actor: u1, task: { owner_id: u1, state: active } }
    expect: { status: returned }
```

- `states` — what values the world may take; the axes fuzz varies.
- `rules` — the always/nevers. Each carries its human `text` (the judgment) and a `check`
  (its compiled, machine-checkable form — the claim DSL that already exists).
- `examples` — named scenarios that must keep holding; the sediment of adjudications.
- `origin: authored` = the human wrote it top-down. `origin: ratified` = it was derived
  from observation and the human stamped it. Both are first-class; neither is required.
  Nobody has to write a complete spec — that is where spec-first always died.

### 1.2 The Recipe — `.grasp/RECIPE.md` (unchanged)

Operational memory: how this repo runs, the observation method per rung, environment pins,
the entrypoint map (feature → symbol), blockers. The model says *what must be true*; the
recipe says *how to find out*. Two files, two kinds of truth. grasp reads neither — they
are the agent's memory, checked into the repo, inherited through git.

### 1.3 Scenario (NEW as a first-class, named object)

A scenario is one exercised behavior: `{ label, scenario, input, outcome }` — a *named*
fuzz case. `label` is domain language ("edit a deleted task"), never input JSON. Scenarios
are the unit the review surface displays and the unit rules quantify over.

### 1.4 Trace (unchanged protocol; demoted role)

Trace v1 stays exactly as is — frames, values, `unobservable`, the observation channel and
its `appAttempt` discipline. Its role changes: a trace is **evidence attached to a
scenario**, opened on drill-down. It is never the front door again.

### 1.5 Claim (unchanged; promoted role)

The checked characterization (`where` predicate + `effect` pattern, cross-tabulated by
grasp against observed cases). In v2 the claim DSL is also the **rule notation**: a rule's
`check` block is a claim template over a scenario. One machine, two uses.

### 1.6 The Verification Report (NEW; the primary surface)

What the human reads after any change: one row per rule and per example.

```
R1  only the owner may edit         conforms   (58 observed cases, 0 counterexamples)
R2  deleted tasks cannot be edited  VIOLATED   (3 counterexamples — ratified 2026-07-07)
E1  owner edits own active task     conforms
—   novel: edit while task is completed now returns partial object — intended?
```

## 2. The vocabulary (closed, deterministic)

Four words. Any sentence the surface renders uses exactly these semantics:

- **conforms** — no counterexample among the N observed cases covering this rule. Always
  carries N. Never rendered as safety.
- **violated** — a counterexample exists to a rule the human authored or ratified. The
  citation names the rule and its ratification. The judgment is the human's own, replayed.
- **untested** — no observed case covers the rule this run (no straddle, no evidence).
- **novel** — observed behavior not covered by any rule. The ONLY category that ends in
  "— intended?". The human's answer either ratifies (sediments into the model) or triggers
  repair.

Banned forever, machine-side: proven, impossible, safe, pass, fail-as-judgment, correct,
broken, bug. (`FAIL` in the inspiration text is exactly what grasp does not say.)

## 3. The loop (the drive train)

```
turn start   agent loads recipe (how to run) + model (what must hold)
generate     the edit is produced TOWARD the model — rules are context, like project docs
check        scenarios derived from: model rules + model states (fuzz axes) + examples
             grasp recomputes every outcome itself; claims/rules checked case by case
report       the Verification Report renders: conforms / violated / untested / novel
adjudicate   only novel rows ask. "intended" → ratified rule/example (sediment);
             "not intended" → repair turn, model unchanged
repair       violations invite SPEC PATCHING first: tighten or add a rule, regenerate —
             "go find the if statement" is the fallback, not the method
```

Determinism requirements, stated once: same code + same model + same seeds ⇒ same report.
All scenario generation is seeded; the clock/RNG/network pins from the recipe apply to
every check run; the report orders rows by rule id, then scenario label.

## 4. The surfaces (reading order, strictly layered)

1. **Report** — rule × status × evidence count. One screen. The daily artifact.
2. **Scenario row** — outcome delta in domain words: "edit deleted task — old: rejected,
   new: returned partial — violates R2".
3. **Claim card** — the checked generalization (where/effect, support, straddle).
4. **Flow** — the call tree with lineage-rendered values. The debugger. (All of v1 lives
   here, unchanged: object deltas, references, plumbing collapse, channel chip.)
5. **Source** — click-through from any frame.

Each layer is one click from the evidence below it. No layer may contain prose the layer
below cannot substantiate — the v1 rule "agent prose is never the surface" holds at every
level: report rows, scenario labels excepted (labels are names, not claims).

## 5. The three oracles (carried over, with one refinement)

- The **agent** generates: code, scenarios, claim/rule compilations, labels. All of it is
  proposal.
- **grasp** checks: recomputes outcomes, cross-tabulates claims, validates protocol shapes,
  refuses malformed or undeclared submissions. It executes nothing and asserts nothing.
- The **human** judges — with one refinement, the entire point of v2: **judgment is
  rendered once and remembered**. Ratification converts a judgment into a standing rule;
  the report replays it forever after. The human can always re-open a rule (edit or delete
  it in the model file — it is theirs).

The moat of v1 is unchanged and restated as binding: observed-never-guessed; grasp computes
divergence itself; tooling failure has exactly one shape (`unobservable`); no phantom
change; legible by default; a single input proves nothing; inputs are real or disclosed.

## 6. The model lifecycle

### 6.1 Authoring (top-down)
The human writes `text` for a rule; nothing else is mandatory. Plain always/never sentences.

### 6.2 Compilation (the propose/check/ratify pattern, reused)
The agent proposes the `check` block for a rule's text — the claim-DSL form plus the
scenario it quantifies over. grasp validates checkability (closed DSL, size caps — the
existing machinery). The human ratifies the compilation once. A rule with no ratified
`check` reports as **untested (uncompiled)** — visible debt, never silent.

### 6.3 Sedimentation (bottom-up)
When a novel behavior is adjudicated "intended", the claim that surfaced it is written into
the model as a `ratified` rule (or example), with date and evidence. The spec is sediment:
every line born from a real run and signed by the human.

### 6.4 The conflict seam (the new "— intended?")
When a hand-edited rule and observed reality disagree, that is not an error state — it is
the question, surfaced as `violated` with both sides shown: the rule's text and date, the
counterexample's scenario and trace. The human resolves by repairing the code or amending
the rule. grasp never picks.

### 6.5 Versioning
The model is a git-tracked repo file. Checkpoint commits carry it; teammates inherit it;
its diff history *is* the history of the team's judgments.

## 7. Enforcement doctrine (how rules about the agent are kept)

- **Prose teaches, structure refuses.** Every discipline starts as skill text; the moment
  it is gamed, it moves into the protocol as a closed enum or required field with a
  self-teaching rejection message. (Precedents: observation channel, appAttempt, evidence,
  repr exactness.)
- **Name capabilities, never tools.** Unchanged from v1 CLAUDE.md; applies to this spec,
  the skills, and all future text. Closed protocol vocabularies are the sanctioned
  exception — they are grasp's own words, not descriptions of the ecosystem.
- **Closed vocabularies are self-teaching.** Any out-of-enum value is refused with the
  legal values listed; paraphrases are rejected, never interpreted.

## 8. Gap table — what exists vs what v2 adds

| Piece | Status |
|---|---|
| Trace protocol, channels, honesty gates | exists (v1) — unchanged |
| Claim DSL + checking (`where`/`effect`, axes, compression) | exists — becomes rule notation |
| Fuzz at root-outcome granularity | exists — becomes the rule checker |
| FlowView lineage/delta rendering | exists — becomes the debugger layer |
| Recipe + entrypoint map + skills | exists — unchanged |
| `.grasp/model.yaml` schema + loader/validator | DONE |
| Scenario `label` on fuzz cases + outcome rows | DONE |
| Verification Report (compute + surface + adjudication buttons) | DONE |
| Ratification write-path ("intended" → staged rule via agent) | DONE (staged; human signs in file) |
| Model-driven scenario/axis generation | prose-steered (skill + SYSTEM); runtime generation open |
| Spec-patching repair loop | DONE (repair-first skill rule + amend button) |

## 9. Phases (deliberate, each independently shippable)

- **Phase 1 — the model exists.** Schema + `validateModel` in `shared/`; agent skill for
  compilation (6.2); rules checked by running them through the existing `grasp_fuzz_diff`
  machinery; report rendered as a first version of the new surface. No UI reordering yet.
- **Phase 2 — review-first surfaces.** Scenario labels; Report becomes the headline view;
  Flow demoted to drill-down. (Pure renderer + one protocol field.)
- **Phase 3 — judgment durability.** "Intended" writes ratified rules/examples into the
  model; every check run re-verifies all ratified rules; `violated` cites ratification.
- **Phase 4 — the model drives.** States generate fuzz axes; rules generate scenarios;
  generation-toward-model added to the SYSTEM prompt; spec-patching offered as the
  first-class repair action.

## 10. Non-goals

- No proofs, no model checking, no "exhaustively verified" — corroboration with counts,
  forever.
- No machine verdicts — the only judgments in the system are the human's, cached.
- No per-repo grasp code — a new codebase still costs zero grasp changes; the model and
  recipe live in the target repo, not in grasp.
- No format wars — YAML is the notation; the triad states/rules/examples is the contract.

## 11. Decisions made in this spec (and the two that are yours)

Decided here, with rationale in-line: model filename and format (1.1); the four-word
vocabulary (2); determinism requirements (3); reading order (4); untested-uncompiled debt
visibility (6.2); phase order (9).

Yours to make before Phase 1:
1. **Model scope** — one `model.yaml` per repo, or one per feature directory? (Monorepos
   like the bridge argue for per-feature; TodoApp argues one file is plenty.)
2. **Ratification friction** — does "intended" write to the model automatically, or stage
   a proposed rule the human confirms in the file? (Auto is smoother; staged is more
   deliberate — consistent with everything else you've chosen, staged is recommended.)
