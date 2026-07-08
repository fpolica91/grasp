# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What grasp is

grasp is **the post-editor**: a desktop review surface for a world where an agent writes the code
and the human owns what it *means*. Instead of a text diff (which tokens moved), grasp shows the
**observed dataflow** — the real call tree, the actual values, and the A→B behavioral change of an
edit — and ends in a neutral question (*"— intended?"*), **never a verdict**.

**Read [`docs/thesis.md`](docs/thesis.md) before any non-trivial change.** It is the anti-drift
north star; the moat below is its operational form. [`README.md`](README.md) is the user-facing
guide (install, providers, features, env table).

## The one architectural idea (read this first)

> **grasp executes nothing. grasp = UI + nodes + skill. The agent is the compiler.**

This is the load-bearing decision. grasp core supplies exactly three things:

1. **The nodes** — the **Trace protocol** (`app/src/shared/trace.ts`): a `TraceDoc` is a real call
   tree of frames (args → calls → return/threw + source line + timing). `validateTrace` rejects
   malformed submissions; a tooling failure is the `unobservable` field, **never a fabricated frame**.
2. **The UI** — `app/src/renderer/src/components/FlowView.tsx` renders a `TraceDoc` as an interactive
   call tree, an A→B `TraceDiff`, and a differential `FuzzDiff`. It collapses frames the agent marks
   `meaningful:false` — **grasp hardcodes no classifier; the agent supplies the meaning.**
3. **The skill** — `trace-flow` / `fuzz-diff` (seeded from `app/src/main/skills.ts`): the agent's
   playbook. It reads the repo, installs deps, runs the real entrypoint, captures the flow, and
   **submits nodes**. grasp validates and renders.

The agent surfaces a flow through three pure, no-execution tools (`app/src/main/backends/tools.ts`):
`grasp_flow` (submit one `TraceDoc`), `grasp_flow_diff` (submit old+new for the A→B change), and
`grasp_fuzz_diff` (submit a `cases_file` of `{input, old, new}` — grasp diffs each pair and surfaces
only the inputs where behavior diverged). Large traces are passed by **file path**, not inline.

**Consequence to protect:** a new codebase must cost **zero** grasp changes. If you find yourself
editing a tracer to make a repo work, that is the smell that the architecture broke — the agent
absorbs that variation. Reference tracers (`app/resources/tracers/{py_trace.py,js_trace,go_trace}`)
are **skill assets** seeded to `~/.grasp/skills/tracers` for the agent to run and *adapt* — **grasp
never spawns them.**

### Legacy that still exists on disk (do not be misled)

- **`engine/`** — the retired Python `dreplay` flow engine, **off the app path**; grasp no longer
  shells it. Only `app/src/main/engine.ts` (imported by `index.ts` for two vestigial IPC handlers
  behind the old `DataflowGraph.tsx`/`DataflowDiff.tsx`/`FuzzView.tsx` components and the
  `dataflow`/`dataflow_diff`/`fuzz` events) still references it. The **live** path is Trace-based
  (`FlowView`, `trace`/`trace_diff`/`fuzz_diff` events). When in doubt, follow the Trace path.

## The moat — non-negotiable (the product, not style)

1. **Observed, never guessed.** Every value is measured from a real run the agent captured, or
   absent. `validateTrace` refuses malformed traces; `status:"unobservable"` (with a reason) is the
   *only* place a tooling failure appears. Never let the agent's prose become the flow — the nodes
   are ground truth, the chat is not.
2. **Facts, not verdicts.** Output ends in a neutral question. Never bug/risk/safe/pass/broken/fail.
   A behavior-preserving edit reads *"same flow — not a pass"*; a fuzz sweep reads *"K diverged out
   of N"*, **never "safe"**. A prettier UI must not become a better liar.
3. **Legible by default.** A 400-frame library dump is a failure. The agent marks plumbing
   `meaningful:false`; `FlowView` collapses it with a "show N plumbing frames" toggle.
4. **A single input proves nothing.** This is why `grasp_fuzz_diff` exists: a bug that only breaks
   inputs you didn't try reads as "same flow" on the one input you picked. `buildFuzzDiff` computes
   divergence from the real traces — it does not trust an agent's "diverged" claim.
5. **No phantom change.** A diff/fuzz against a side that could not be observed is dropped, never
   surfaced as fake behavior.

When you touch any renderer or tool, enforce these in the code — several are structural (the
`unobservable` field, the `meaningful` flag), not just prose.

## The agent seam (`app/src/main/`)

grasp is agent-agnostic. `AgentBackend` (`backends/types.ts`) is a tiny contract — `run(turn, emit)`
streams `AgentEvent`s. Four backends, all registered in `agent.ts`:

- **`backends/anthropic.ts`** — the load-bearing **shared factory** `makeAnthropicBackend(opts)`.
  This is the full agent loop: `callModel` (Anthropic Messages SSE) + the moat (SYSTEM prompt,
  ask-mode approval gate, post-edit fuzz nudge, `liveSurface` re-observation) + the trajectory
  inspector records. GLM (api.z.ai) and Claude (api.anthropic.com) both speak the Anthropic Messages
  + tool_use wire, so each is a thin config over this factory. **Change the loop once here, not
  per-provider.**
- **`backends/glm.ts`** — GLM, the default (`GRASP_MODEL` default `glm-5.2`).
- **`backends/claude.ts`** — native Anthropic API (no CLI); models `claude-sonnet-5` /
  `claude-opus-4-8` / `claude-fable-5` / `claude-haiku-4-5-…`. Key under the `anthropic` vault provider.
- **`backends/claude-code.ts`** — drives the `claude` CLI (brings its own tools; needs the binary on PATH).
- **`backends/openai.ts`** — any OpenAI-compatible chat-completions endpoint (separate wire, not the factory).

`agent.ts` is a thin dispatcher: picks the backend, runs pre/post-turn git checkpoints
(`checkpoint.ts` — commits the workspace as a visibly-labeled `grasp:` commit so HEAD = "state
before this turn" and an A→B diff always has a baseline; these are real commits, they show in the
user's log), owns the stop signal (`stopAgent()`), `MAX_STEPS = 40`. `tools.ts` holds the shared
registry (file/shell tools + the three `grasp_*` submit tools + `task` subagent + `TodoWrite`); its
`SYSTEM` prompt encodes the moat (verify via `grasp_flow*`, never an ad-hoc `run_bash` harness).
**After a mutating edit, the factory injects a one-time `<system-reminder>` nudging the agent to
`grasp_fuzz_diff` before concluding** — that is how the differential fuzz "auto-surfaces" without
grasp executing anything. `withProjectContext` appends the workspace's own `CLAUDE.md`/`AGENTS.md`,
kept separate from the moat SYSTEM so project text can never override it.

**Model trajectory:** the factory emits one `trajectory_call` per model round-trip (input messages
by role, reasoning, tool calls, output, tool results, tokens, duration); `TrajectoryInspector.tsx`
renders it as a request/response inspector. `calls` is persisted into the `SessionRecord` and
restored on launch + on session open.

**Streaming:** `backends/sse.ts` is the shared SSE parser. **GLM quirk:** real `input_tokens` arrive
in `message_delta.usage` (the `message_start` usage is a zero placeholder); the factory captures both.

**IPC:** `preload/index.ts` exposes the typed `GraspApi` (`shared/types.ts`); agent progress streams
over the `agent:event` channel. Credentials are per-provider via Electron `safeStorage` (`vault.ts`),
never plaintext; env overrides (`GRASP_*_KEY`) are honored in-memory only.

## Commands

The app is the product. **There is no app unit-test suite — `typecheck` is the gate.**

```bash
cd app && npm install
cd app && npm run typecheck   # tsc --noEmit over tsconfig.node.json + tsconfig.web.json — THE gate; run before every commit
cd app && npm run dev         # electron-vite dev (desktop app + HMR)
cd app && npm run build       # build main/preload/renderer to app/out
cd app && npm start           # electron-vite preview
```

The `engine/` directory is retired from the product; only run its suite if you are deliberately
touching that legacy code:

```bash
cd engine && make venv && make test   # pytest: flow canaries FC1–FC8 + the no-verdict conformance moat
```

### Verifying UI changes headlessly

There is no automated UI test. Real changes to `FlowView`/the flow surfaces are validated by
rendering real trace JSON and screenshotting under Xvfb. When you change a renderer, produce a
screenshot from real (not hand-written) data and confirm the moat visually (no verdict words,
plumbing collapsed, `unobservable` honest).

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `GRASP_WORKSPACE` | `process.cwd()` | default agent workspace at boot |
| `GRASP_MODEL_BASE` | `https://api.z.ai/api/anthropic` | GLM endpoint (Anthropic Messages format) |
| `GRASP_MODEL` | `glm-5.2` | GLM model id |
| `GRASP_GLM_MODELS` | `glm-5.2,glm-5.1,glm-4.6,glm-4.5-air` | GLM model list |
| `GRASP_API_KEY` | — | GLM key for dev/CI; in-memory, never persisted |
| `GRASP_CLAUDE_BASE` | `https://api.anthropic.com` | Claude endpoint (or proxy) |
| `GRASP_CLAUDE_MODEL` / `GRASP_CLAUDE_MODELS` | `claude-sonnet-5` / `claude-sonnet-5,claude-opus-4-8,claude-fable-5,…` | Claude model + list |
| `GRASP_ANTHROPIC_KEY` / `GRASP_CLAUDE_KEY` | — | Anthropic key for dev/CI; in-memory only |
| `GRASP_CLAUDE_CONFIG_DIR` | `~/.claude-zai` if present else `~/.claude` | routes the `claude` CLI backend's config |
| `GRASP_OPENAI_BASE` / `GRASP_OPENAI_MODELS` | OpenAI defaults | OpenAI-compatible endpoint + model list |
| `GRASP_OPENAI_KEY` | — | OpenAI key for dev/CI |

## Working conventions

- **Match the shared contracts on both sides.** `shared/trace.ts` is imported by main (`tools.ts`)
  and renderer (`FlowView.tsx`, `App.tsx`); `shared/types.ts` defines `AgentEvent`, `GraspApi`,
  `TrajectoryCall`, `SessionRecord`. Change a shape in one place → the other must follow.
- **The Anthropic loop is shared.** Anything that applies to GLM *and* Claude belongs in
  `anthropic.ts` (`makeAnthropicBackend`), not duplicated in `glm.ts`/`claude.ts` (those are thin
  configs). OpenAI's wire differs, so it stays separate.
- **The color system lives in `renderer/src/index.css`.** The `@theme` block holds the full palette
  (semantic success/warning/destructive, git/diff, 16-color ANSI terminal, the accent blue);
  `[data-theme="daylight"]` overrides for light. The CodeMirror editor (`Files.tsx`) carries its own
  One Dark `HighlightStyle`; the terminal (`Terminal.tsx`) and hljs code blocks read the same ANSI
  set. Keep them coherent when adding colored UI.
- **A linter reformats files between a Read and an Edit** in this workspace, which makes exact-match
  `Edit` calls fail intermittently. Prefer scripted edits (a `python3 -` heredoc that rewrites the
  file) for multi-line insertions, and always re-verify with `npm run typecheck`.
- **Never kill Electron with `pkill -f`** (it matches the launching shell) — use `pkill -x electron`.
- **Task tracking uses `bd` (beads)** — run `bd prime` for the workflow. Do not use TodoWrite/TaskCreate for work tracking.
