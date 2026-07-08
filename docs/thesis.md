# grasp — the post-editor

> Working name. `grasp`, because the problem is: programmers see the code that changed
> but don't **grasp what the change actually does to their app**. This tool makes them grasp it.

## 0. What this is (read before touching anything)

grasp is the **post-editor**: the review surface for a world where the agent writes the code
and the human owns what it *means*. It is the **compiler of the vibe-coding era** — or, the
**OS of generative programming**.

The paradigm shift, stated once:

- For 50 years the **source file** was the primary object because humans *authored* it. Every
  editor affordance (autocomplete, go-to-def, the file tree, the diff) is scaffolding for
  authorship.
- When the machine authors, that scaffolding is **vestigial**, and the review step is still
  pointed at the worst possible artifact: the **text diff**. A diff shows which *tokens* moved,
  not what your *application now does*. So the human is asked to be the oracle of correctness
  while shown the least informative representation of the change. They approve diffs they don't
  understand.
- grasp replaces the **unit of review**: from *diff* to **observed dataflow**. The human never
  grades code they can't understand — they **adjudicate behavior they can see**.

The loop inverts:

```
OLD:  prompt → agent writes → human reads diff → guesses behavior → approves
grasp: prompt → agent writes → RUN IT FOR REAL → render the observed dataflow (A→B)
       → human adjudicates the consequence → answer becomes the next prompt
```

## 1. The three oracles (never merged — this is why it's trustworthy)

- **The agent = the generator.** A guess-machine: reads and predicts. Native tongue: tokens.
- **grasp's engine = the observer.** Runs the guess for real, surfaces measured facts,
  **refuses to judge.** Native tongue: consequences.
- **The human = the judge.** The only holder of the business rules, edge cases, intended
  bypasses, expected behaviors. Native tongue: intent.

The engine is the **decompiler**: agent compiles *intent → code*; grasp decompiles *code →
observed behavior*; the human checks the round trip. None of the three does another's job.

## 2. The moat — carried over verbatim from dreplay (non-negotiable)

grasp's engine IS dreplay's flow instrument (`docs/what-this-is.md` in the reference repo). The
seven principles hold without exception:

1. **Observed, never guessed.** Every value/count/state shown is measured from a real execution
   or labelled `you supply`. `Operand(provenance="guessed")` **raises**. There is no
   model-inferred operand, ever. **The engine must never be an LLM in a trenchcoat** — if the
   agent generates the flow, the flow is a guess and the whole thesis is dead.
2. **Facts, not verdicts.** Output ends in a neutral open question ("— intended?"). Never
   bug/risk/safe/pass. Pinned by `tests/test_flow_conformance.py`.
3. **Show the operands, not the conclusion.**
4. **Reproducible facts.** Same code + same input ⇒ same observed flow. Clock frozen, RNG seeded.
5. **Legible by default or it's unread.** Business-meaningful nodes only; plumbing collapsed.
6. **Surface, never judge.**
7. **Do not fake the plumbing.** A component that can't be built correctly fails visibly. No
   stub that returns plausible output.

## 3. Architecture — organ vs shell vs graph

```
grasp/
  engine/   the ORGAN (from dreplay's flow half). Executes, observes, types, classifies,
            diffs, fuzzes, makes-runnable. The one thing the agent CANNOT drive.
  graph/    the SURFACE (net-new, the 80%). The 1000X interactive dataflow graph.
  shell/    the CHASSIS (from ZCode's Electron/React, stripped). Panels + agent loop.
  docs/     this.
```

### The line: skills orchestrate, code observes

The agent drives **when/what** to trace (via skills/tools it calls). The agent NEVER drives the
observation itself. That boundary is the entire moat.

### engine keep-list (the organ)
`flow.py` (model + provenance guard) · `instrument.py` (the `sys.settrace` tracer — the
irreducible core) · `flow_diff.py` (behavioral A→B diff = **the new diff**) · `flow_fuzz.py`
(input variation = **the new stack trace**) · classifier + `vocabulary.py` + `ast_vocab.py`
(legible-by-default) · `canonical.py` (hostile-repr-safe capture) · `recipe.py` (make any repo
runnable) · language adapters (`adapter/*_flow.py`, `js_trace`, `ts_strip`, `java_vocab`) ·
`flow_render.py` (JSON the graph consumes) · fuzz egress wall (`_seccomp`, `containment`,
`egress`) · `types.py`/`schema.py` (shared contract).

### cut-list (delete — the old differ product, TUIs, CLI ceremony)
The entire **differential-replay engine**: `api · replay · noise · fuzzer(differ) · diff ·
boundary · render · harvest · fault · harness · isolation · ci · redact · cli` and differ
adapters `adapter/{base,python,node}.py`. Both **TUIs** (`flow_tui`, `flow_diff_tui`) — the
React graph replaces them. `flow_cli.py` collapses to a **thin skill shim** (no arg-parsing, no
exit-code-as-signal). `llm_fuzzer` (optional). *(Prune incrementally, gate green after each cut.)*

### The old stack → the new stack (every artifact has a behavioral successor)
| Text era | Behavior era | Engine piece |
|---|---|---|
| Text diff | **Dataflow diff** (A→B) | `flow_diff` |
| Stack trace | **Input variations** (edge cases) | `flow_fuzz` |
| PR/MR comment | **Recorded graph + adjudication** | evidence + recording (TODO) |
| "Tests pass ✅" | **A question** ("is this expected?") | "— intended?" |
| The PR description | **Checked contract delta** — where + how, checked per observed case | claim check in `shared/trace.ts` |
| The editor | **The behavioral surface** | `graph/` (net-new) |

## 4. The graph — the 80%, and its design law

Not mermaid. A real, interactive dataflow surface (this is why we need ZCode's chassis). Nodes
are business objects + the values bound to them; edges are transformations. It must be:
legible-by-default (collapse plumbing), diffable (A/B overlay), drillable (evidence on expand),
and **interactive** — clicking an input node → "vary this" runs the fuzzer and shows *which
variants bend which downstream invariant*. `flow`, `flow_diff`, `flow_fuzz` become **one object**.

**Design law (the trap at 1000X): a beautiful UI is a more convincing liar.** The moat is
enforced in the engine today; the moment we render a gorgeous graph it starts making claims the
engine never made. So the discipline moves into the **visual language**:

- Unexercised paths are **visibly ghosted**, never omitted — the eye must see the coverage boundary.
- `observed` operands and `you supply / unknown` operands are **visually distinct** — a fact is
  never confused with a blank.
- Nothing is ever green/red/✓/⚠. The graph's terminal state is a **question node**, rendered as
  a question. If the UI can't render "I don't know" as beautifully as "here's what happened,"
  it's a liar with good taste.

## 5. ZCode (reverse-engineered) — what we keep, what we rip out

ZCode 3.2.5 = a Claude-Code-compatible multi-provider agent (`glm/zcode.cjs`) wrapped in an
Electron/React shell. It already has every panel the post-editor needs — terminal, webview,
chat — and is already agent-first (the editor is vestigial). We keep the **shell** and do a
one-for-one pane swap: **delete the diff pane, drop the dataflow graph in its slot.**

**Rip out on day one:** Alibaba **ARMS RUM** telemetry (`@arms/rum-electron`), the **Lark/Feishu
SDK**, the multi-provider **router**, and the `cdn-zcode.z.ai` **electron-updater** channel.
Otherwise a "full understanding, minimal guessing" tool quietly narrates its users to someone
else's dashboard.

Reference extraction lives at `/home/fabricio/Desktop/zcode-re/`.

## 6. Reference

The dreplay codebase (`/home/fabricio/Desktop/harness`) is preserved untouched as the engine's
source of truth and the differ's home. grasp's `engine/` is carved from its flow half.
