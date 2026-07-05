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
5. **Visual discipline (the graph trap).** Unexercised paths are *visibly ghosted*, never omitted. `observed`
   operands are visually distinct from `declared`/`unknown`. Nothing is ever green/red/✓/⚠ — the terminal state
   is a **question node**. When you touch any renderer (Flow/Dataflow), enforce the moat in the visual language.

## Architecture — organ, surface, and the agent seam

```
engine/   the ORGAN (Python). Real execution tracer → observed dataflow graph + A→B diff + fuzz.
          The one thing the agent cannot fake. The `dreplay` package.
app/      the SURFACE + shell (Electron + React + TS). Drives a real tool-use agent over a pluggable
          backend seam, with first-class observe/diff/fuzz/trace tools. Owned source.
graph/    standalone rendered graph examples (HTML/JSON) — what the engine's --html emits.
skills/   grasp packaged as a skill (`observe-flow/`) — an alternate distribution.
docs/     thesis.md (the north star).
```

**The seams to keep in sync:**
- `app/src/main/engine.ts` shells `python -m dreplay.skill observe|diff` and parses its JSON graph contract.
- `app/src/shared/types.ts` (`GraphModel`/`GraphDiffModel`/`FuzzReport`/`AgentEvent`/`GraspApi`) mirrors
  `engine/dreplay/flow_graph.py`. **Change one side's shape, change the other.**

> ⚠️ **`README.md` and `docs/thesis.md` are partially stale.** They describe a `shell/` (ZCode chassis)
> and state "grasp is not an app." The actual direction is **`app/`** — a from-scratch Electron app.
> Trust the code; the docs describe the original plan.

### engine/ — `dreplay` package
- `flow.py` — the flow **model** + the provenance guard (principle #1). `observe_flow(...)` is the entry.
- `instrument.py` — the `sys.settrace` tracer (the irreducible core, Python).
- `flow_diff.py` — behavioral A→B diff. `skill.diff` calls `align_and_diff`.
- `flow_fuzz.py` — input variation. Python only, walled by default.
- `flow_graph.py` — the graph data contract + HTML render consumed by `app/` and `graph/`.
- `skill.py` — the **agent-callable shim** (`python -m dreplay.skill observe|diff|fuzz`).
- `adapter/` — Go / C++ / C# / Java / JS / TS adapters (toolchain tests self-skip when the compiler is absent).
- Console scripts (`pyproject.toml`): `dreplay` (old differ CLI), `dreplay-flow` (`flow_cli:main`).

### app/ — Electron + React + TS, three build targets (main / preload / renderer)

**The agent seam (the big picture):** grasp is agent-agnostic. `AgentBackend`
(`app/src/main/backends/types.ts`) is a tiny contract — `run(turn, emit)` streams `AgentEvent`s
and returns the conversation state — implemented three ways:
- `backends/glm.ts` — GLM on the Anthropic Messages wire (the default; `GRASP_MODEL` default `glm-5.2`).
- `backends/openai.ts` — any OpenAI-compatible chat-completions endpoint (`GRASP_OPENAI_BASE`).
- `backends/claude.ts` — the Claude Code CLI (brings its own tools; shares `liveSurface` only).

`main/agent.ts` is now a **thin dispatcher**: picks the backend, runs pre/post-turn git checkpoints
(`checkpoint.ts` — keeps HEAD = "state before this turn" so the A→B diff always has a baseline),
and owns the user stop signal (`stopAgent()`). `MAX_STEPS = 40`.

**The tool registry** (`backends/tools.ts`, shared by glm + openai): file/shell (`read_file`,
`write_file`, `edit_file` [targeted edit with a stale-guard], `notebook_edit`, `list_dir`, `run_bash`),
the **organ** (`grasp_observe` / `grasp_diff` / `grasp_fuzz` — shell the Python engine and surface
observed dataflow), `use_skill`, `task` (depth-1 subagent), and `TodoWrite`/`TodoRead`. The `SYSTEM`
prompt enforces the moat (the agent must verify via observe/diff, never an ad-hoc bash harness).
`MUTATING_TOOLS` drives both ask-mode approval (`approvals.ts`) **and** the live re-observe trigger
— every code mutation re-runs the observed dataflow rail. `withProjectContext(workspace, base)`
appends the workspace's `CLAUDE.md`/`AGENTS.md` to the system prompt (kept separate from the moat
SYSTEM so project text can never override it).

**SSE streaming:** `backends/sse.ts` is a shared SSE parser; `glm.ts` + `openai.ts` send `stream:true`
and reassemble the events (Anthropic 7-event / OpenAI delta) back into the same content/usage shape,
forwarding `text_delta` to the UI as it's written. **GLM quirk:** the real `input_tokens` arrive in
`message_delta.usage` (the `message_start` usage is a zero placeholder) — captured there.

**Flow rebuild — IN PROGRESS (parts 1–2 of 4).** A new trace-native Flow is being built alongside the
engine-based one:
- `shared/trace.ts` — **Trace protocol v1** (`TraceDoc`: a real call tree of frames with args/ret/threw/durMs;
  honesty via `validateTrace`; a tooling failure is the `unobservable` field, never a fake frame).
- `main/tracer.ts` — shells a native tracer (`resources/tracers/py_trace.py`, Python via `settrace`;
  JS/TS via the V8 inspector is step 4). ⚠️ **`resources/tracers/py_trace.py` is NOT yet committed** —
  until it is, `grasp_trace` on Python returns `unobservable: tracer not found`.
- `grasp_trace` tool + `{type:'trace'}` event + `components/FlowView.tsx` (interactive call-tree) + a
  `traces[]` run history.
- The A→B `TraceDiff` type exists but is "computed in the app" — **not yet wired**.
This coexists with the engine-based `DataflowGraph` / `DataflowDiff` / `FuzzView`. Don't assume the
old flow is the only flow.

**IPC + renderer:** `preload/index.ts` exposes the typed `GraspApi` (`shared/types.ts`) — chat,
observe, fuzz, agent, onAgentEvent, keyStatus/setKey (per-provider), defaultWorkspace, backends,
sessions (save/delete/load), approve (ask-mode), flowNow, stopAgent, workflows, projects, skills,
term* (node-pty), listTree, readFile/writeFile/fileDiff. Agent progress streams over the `agent:event`
channel (`text` · `text_delta` · `text_end` · `tool_use` · `tool_result` · `dataflow` · `dataflow_diff`
· `fuzz` · `trace` · `plan` · `approval_request` · `usage` · `done` · `error`).
`renderer/App.tsx` is the shell: Sidebar · Conversation · resizable Editor/Flow/Browser panes ·
docked Terminal · activity rail.

**Credentials:** model keys per-provider via Electron `safeStorage` (`vault.ts`), never plaintext,
never shipped. `GRASP_API_KEY` is an in-memory dev/CI override, honored but never persisted.

## Commands

### Engine (Python — the organ)
```bash
cd engine && make venv        # creates engine/.venv (pytest, jsonschema, pyyaml, ast-grep-py, esprima)
cd engine && make test        # = .venv/bin/pytest — flow canaries (FC1–FC8) + conformance moat + all tests
                              #   language-toolchain tests self-skip when go/java/dotnet/g++/node are absent
# Run one test file / one canary:
cd engine && .venv/bin/pytest tests/test_flow_diff.py -q
cd engine && .venv/bin/pytest flow_canaries/test_flow_canaries.py -k fc3

# The skill the app shells (prints the JSON graph contract; add --html for the rendered graph):
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
| `GRASP_PY` | `<engine>/.venv/bin/python` | engine **and** native-tracer interpreter (`engine.ts`, `tracer.ts`) |
| `GRASP_MODEL_BASE` | `https://api.z.ai/api/anthropic` | GLM endpoint (Anthropic Messages format) |
| `GRASP_MODEL` | `glm-5.2` | GLM model id |
| `GRASP_OPENAI_BASE` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `GRASP_OPENAI_MODELS` | `gpt-5.2,gpt-5.1,gpt-4.1` | OpenAI model list |
| `GRASP_API_KEY` | — | model key for dev/CI; honored in-memory, never persisted |
| `GRASP_WORKSPACE` | `process.cwd()` | default agent workspace |

The app shells `python -m dreplay.skill`, so the engine venv (`make venv`) must exist before the
observe/diff/fuzz tools will work — otherwise they return the honest "engine python not found" error.
