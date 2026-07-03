# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What grasp is

grasp is **the post-editor**: a review surface for a world where an agent writes the code
and the human owns what it *means*. Instead of showing a text diff (which tokens moved),
grasp **runs the change for real**, renders the **observed dataflow** — how data enters,
what happens now, and what happened before (the A→B) — and ends in a neutral question
(*"is this what you expected?"*), never a verdict.

**Read [`docs/thesis.md`](docs/thesis.md) before touching anything.** It is the anti-drift
north star. The whole codebase is built around its rules; violating them silently breaks
the product's reason to exist.

## The moat — non-negotiable (enforced in code + tests)

These are not style preferences. They are the product, and several are pinned by failing tests:

1. **Observed, never guessed.** Every value shown is measured from a real execution or labelled
   `declared`/`unknown` (human-supplied). `Operand(provenance="guessed")` **raises** (`engine/dreplay/flow.py`).
   **The engine must never be an LLM in a trenchcoat** — if the agent generates the flow, the flow is a guess
   and the thesis is dead.
2. **Facts, not verdicts.** Output ends in a neutral open question, never bug/risk/safe/pass/broken/wrong/fail/danger/insecure.
   Pinned by `engine/tests/test_flow_conformance.py` over both the JSON contract and the HTML render — a beautiful
   UI must not become a better liar.
3. **The line: skills orchestrate, code observes.** The agent decides *when/what* to trace; it never drives the
   observation itself.
4. **No phantom change.** A diff against a side that could not be observed is refused (`ok:false`), never surfaced as fake behavior (`engine/dreplay/skill.py:diff`).
5. **Visual discipline (the graph/`app/` trap).** Unexercised paths are *visibly ghosted*, never omitted. `observed`
   operands are visually distinct from `declared`/`unknown`. Nothing is ever green/red/✓/⚠ — the terminal state
   is a **question node**. When you touch the renderer, enforce the moat in the visual language.

## Architecture — two halves, one seam

```
engine/   the ORGAN (Python). Real execution tracer → observed dataflow graph + A→B diff + fuzz.
          The one thing the agent cannot fake. The `dreplay` package.
app/      the SURFACE + shell (Electron + React + TS). Drives a real tool-use agent (GLM via
          Anthropic Messages wire) with first-class grasp_observe / grasp_diff tools. Built
          from scratch as owned source.
graph/    standalone rendered graph examples (HTML/JSON) — what the engine's --html emits and the app shows.
skills/   grasp packaged as a ZCode skill (`observe-flow/`) — an alternate distribution to the app.
docs/     thesis.md (the north star).
```

**The seam:** `app/src/main/engine.ts` shells the Python skill
(`python -m dreplay.skill observe|diff`) and parses its JSON graph contract. The shared
contract on both sides is `app/src/shared/types.ts` (`GraphModel` / `GraphDiffModel`), which
mirrors `engine/dreplay/flow_graph.py`. If you change one side's shape, change the other.

> ⚠️ **`README.md` and `docs/thesis.md` are partially stale.** They describe a `shell/`
> (the reverse-engineered ZCode chassis) and state "grasp is not an app." The actual current
> direction on this branch is **`app/`** — a from-scratch Electron app, *not* ZCode. Trust
> the code; the docs describe the original plan.

### engine/ — `dreplay` package
- `flow.py` — the flow **model** + the provenance guard (principle #1). `observe_flow(...)` is the entry.
- `instrument.py` — the `sys.settrace` tracer (the irreducible core, Python).
- `flow_diff.py` — behavioral A→B diff (= the new diff). `skill.diff` calls `align_and_diff`.
- `flow_fuzz.py` — input variation (= the new stack trace). Python only, walled by default.
- `flow_graph.py` — the graph data contract + HTML render consumed by `app/` and `graph/`.
- `vocabulary.py` / `ast_vocab.py` / `canonical.py` — legible-by-default collapsing + hostile-repr-safe capture.
- `recipe.py` — provision a runnable env for a repo (`--recipe auto|synth`).
- `skill.py` — the **agent-callable shim**. Three capabilities: `observe`, `diff`, `fuzz`. Emits the graph contract as JSON (or `--html`).
- `adapter/` — language adapters: Go / C++ / C# / Java / JS / TS. Toolchain tests self-skip when the compiler is absent.
- `_seccomp.py` / `containment.py` / `egress.py` — the fuzz egress wall.
- Console scripts (`pyproject.toml`): `dreplay` (old differ CLI), `dreplay-flow` (`flow_cli:main`).

### app/ — electron-vite, three build targets
- `src/main/` — Electron main process (Node). `index.ts` wires IPC; `agent.ts` is the agentic loop;
  `engine.ts` is the Python seam; `model.ts` the LLM client; `vault.ts` the encrypted credential store.
- `src/preload/` — contextBridge. Exposes the typed `window.grasp` API (`GraspApi` in `shared/types.ts`).
- `src/renderer/` — React 19. `App.tsx` is the shell (Sidebar · Conversation · live dataflow instrument).
  `DataflowGraph` / `DataflowDiff` render the contract; `KeyGate` gates on a model key.
- **The agent loop** (`agent.ts:runAgent`): up to `MAX_STEPS` (16) turns. Tools: `read_file`, `write_file`,
  `list_dir`, `run_bash`, `grasp_observe`, `grasp_diff`. **Live surfacing:** when a `watch` entrypoint is set
  and the agent runs `write_file`/`run_bash`, it auto re-diffs (OLD=HEAD vs NEW=working tree) and streams the
  evolving dataflow — the graph moves as the agent works, without it having to ask.
- IPC: main handles `grasp:chat|observe|agent|keyStatus|setKey`; agent progress streams over `agent:event`
  (`text|tool_use|tool_result|dataflow|dataflow_diff|done|error` — see `AgentEvent`).
- **Credentials:** model key stored via Electron `safeStorage` (OS keychain), never plaintext, never shipped
  (`vault.ts`). `GRASP_API_KEY` is an in-memory dev/CI override that is honored but never persisted.

## Commands

### Engine (Python — the organ)
```bash
cd engine && make venv        # creates engine/.venv (pytest, jsonschema, pyyaml, ast-grep-py, esprima)
cd engine && make test        # = .venv/bin/pytest — flow canaries (FC1–FC8) + conformance moat + all tests
                              #   language-toolchain tests self-skip when go/java/dotnet/g++/node are absent
# Run one test file / one canary:
cd engine && .venv/bin/pytest tests/test_flow_diff.py -q
cd engine && .venv/bin/pytest flow_canaries/test_flow_canaries.py -k fc3

# The skill the app actually shells (prints the JSON graph contract; add --html for the rendered graph):
cd engine && .venv/bin/python -m dreplay.skill observe \
  --repo engine --entrypoint flow_canaries.scenarios.create_organization --input '{"name":"Acme"}'
```

### App (Electron + React + TS — the surface)
```bash
cd app && npm install
cd app && npm run dev         # electron-vite dev (launches the desktop app + HMR)
cd app && npm run build       # build all three targets to app/out
cd app && npm start           # electron-vite preview
cd app && npm run typecheck   # tsc --noEmit for both tsconfig.node.json and tsconfig.web.json
                              #   (there is NO unit-test suite for the app — typecheck is the gate)
```

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `GRASP_ENGINE` | `../engine` (from `app/out/main`) | path to the Python engine |
| `GRASP_PY` | `<engine>/.venv/bin/python` | engine interpreter (`engine.ts` requires it to exist) |
| `GRASP_MODEL_BASE` | `https://api.z.ai/api/anthropic` | model endpoint (Anthropic Messages format) |
| `GRASP_MODEL` | `glm-4.6` | model id (used by both `model.ts` and `agent.ts`) |
| `GRASP_API_KEY` | — | model key for dev/CI; honored in-memory, never persisted |
| `GRASP_WORKSPACE` | `process.cwd()` | default agent workspace |

The app shells `python -m dreplay.skill`, so the engine venv (`make venv`) must exist before the app's
observe/diff tools will work — otherwise they return the honest "engine python not found" error.
