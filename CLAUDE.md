# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What grasp is

grasp is **the post-editor**: a desktop review surface for a world where an agent writes the code
and the human owns what it *means*. Instead of a text diff (which tokens moved), grasp shows the
**observed dataflow** — the real call tree, the actual values, and the A→B behavioral change of an
edit — and ends in a neutral question (*"— intended?"*), **never a verdict**. v2 adds a standing
**behavior model** so a judgment, once rendered by the human, is remembered and replayed.

Docs, in reading order:
- [`docs/thesis.md`](docs/thesis.md) — the anti-drift north star. **Read before any non-trivial change.**
- [`docs/spec-v2.md`](docs/spec-v2.md) — the behavior-model spec (implemented, all four phases).
- [`README.md`](README.md) — user-facing guide (install, providers, features, env table).
- [`UX-GAPS.md`](UX-GAPS.md) — severity-ranked open UX defects with file:line pointers; some items
  are already partially fixed — re-verify against the code before acting on one.

## The one architectural idea (read this first)

> **grasp executes nothing. grasp = UI + nodes + skill. The agent is the compiler.**

This is the load-bearing decision. grasp core supplies exactly three things:

1. **The nodes** — the protocols in `app/src/shared/`:
   - `trace.ts` — a `TraceDoc` is a real call tree of frames (args → calls → return/threw + source
     line + timing). `validateTrace` rejects malformed submissions; a tooling failure is the
     `unobservable` field, **never a fabricated frame**.
   - `model.ts` — the **behavior model** (see next section): `validateModel` gates
     `.grasp/model.yaml`; `checkModel` recomputes every rule against observed fuzz cases into a
     `ModelReport`.
2. **The UI** — `renderer/src/components/FlowView.tsx` renders a `TraceDoc` as an interactive call
   tree, an A→B `TraceDiff`, a differential `FuzzDiff` (with the model's report rows), and
   `IntroView`. It collapses frames the agent marks `meaningful:false` — **grasp hardcodes no
   classifier; the agent supplies the meaning.**
3. **The skill** — seeded from inline bodies in `app/src/main/skills.ts` to `~/.grasp/skills`
   (sha256 seed-marker discipline: a pristine seed upgrades in place, a user edit is never
   clobbered, a deleted default stays deleted). **There are no shipped tracers** — the skill
   teaches the agent to build observation per-repo from scratch; the retired tracer assets are
   "the tracer graveyard", the lesson behind the naming convention below.

The agent surfaces behavior through pure, no-execution submit tools (`main/backends/tools.ts`):
`grasp_flow` (one `TraceDoc`), `grasp_flow_diff` (old+new → A→B change), `grasp_fuzz_diff` (a
`cases_file` of `{input, old, new}` — grasp diffs each pair, surfaces only divergent inputs, and
attaches the checked `ModelReport`), and `grasp_intro` (workspace introduction). Large traces pass
by **file path**, not inline. `flowNow`/`liveSurface`/`rememberWatch` in tools.ts are deliberate
**no-op seams** — grasp runs nothing, ever; the agent submits explicitly.

**Consequence to protect:** a new codebase must cost **zero** grasp changes. The model and recipe
live in the *target* repo (`.grasp/model.yaml`, `.grasp/RECIPE.md`), never in grasp. If a repo
needs a grasp edit to work, the architecture broke — the agent absorbs that variation.

### Legacy that still exists on disk (do not be misled)

- **`engine/`** — the retired Python `dreplay` engine. `main/engine.ts` still spawns it, but only
  for the vestigial `dataflow`/`dataflow_diff`/`fuzz` events behind `DataflowGraph.tsx`/
  `DataflowDiff.tsx`/`FuzzView.tsx`; the one still-reachable caller is FlowView's "vary this
  input" button (`grasp:fuzz`). The **live** path is Trace-based (`FlowView`;
  `trace`/`trace_diff`/`fuzz_diff`/`intro` events). When in doubt, follow the Trace path.
- **Top-level `graph/`, `shell/`** — demo/screenshot assets and the gitignored ZCode extraction;
  off the app path. **`skills/observe-flow/`** — a standalone exportable skill (installed via its
  own INSTALL.md), *not* what the app seeds. **`TicTacToe.tsx`** — an orphan demo fixture.

## The behavior model (v2 — what makes judgment durable)

`.grasp/model.yaml` lives at the **owning repo's root** (the nearest git root — grasp refuses to
read or write a model at a container workspace that merely holds repos; `tools.ts` walks up to
find the owner). It is the durable, git-tracked statement of intent: `states` (the axes fuzz
varies), `rules` (always/nevers, each with human `text` and a compiled `check`), `examples`
(named scenarios that must keep holding). `origin: authored` = written top-down; `origin:
ratified` = sedimented from an adjudicated observation, with date and evidence; `staged: true` =
proposed by the agent, awaiting the human's signature in the file. `.grasp/RECIPE.md` is the
agent's operational memory (how to run this repo); grasp reads the model to check it, never the
recipe.

The report vocabulary is a **closed four-word enum** — enforce it in any surface you touch:
- **conforms** — always with the observed-case count N; never rendered as safety.
- **violated** — a counterexample to a rule the human authored/ratified; the citation replays
  *their* judgment, it is not grasp's verdict.
- **untested** — no observed case covers the rule; an uncompiled rule reports as visible debt.
- **novel** — the ONLY row that ends in *"— intended?"*; the answer either ratifies (sediments
  into the model) or triggers repair.

Machine-side banned words, forever: proven, impossible, safe, pass, fail-as-judgment, correct,
broken, bug.

## The moat — non-negotiable (the product, not style)

1. **Observed, never guessed.** Every value is measured from a real run the agent captured, or
   absent. `validateTrace` refuses malformed traces; `status:"unobservable"` (with a reason) is
   the *only* shape a tooling failure may take. Never let the agent's prose become the flow — the
   nodes are ground truth, the chat is not.
2. **Facts, not verdicts.** Output ends in a neutral question. A behavior-preserving edit reads
   *"same flow — not a pass"*; a fuzz sweep reads *"K diverged out of N"*, **never "safe"**. The
   only verdict-shaped word grasp renders is `violated`, and that is the human's own rule
   replayed with citation. A prettier UI must not become a better liar.
3. **Legible by default.** A 400-frame library dump is a failure. The agent marks plumbing
   `meaningful:false`; `FlowView` collapses it with a "show N plumbing frames" toggle.
4. **A single input proves nothing.** This is why `grasp_fuzz_diff` exists: a bug that only breaks
   inputs you didn't try reads as "same flow" on the one input you picked. `buildFuzzDiff`
   computes divergence from the real traces — it does not trust an agent's "diverged" claim.
   After a mutating edit the shared loop injects a one-time `<system-reminder>` nudging the agent
   to fuzz-diff before concluding — that is how the differential fuzz auto-surfaces without grasp
   executing anything.
5. **No phantom change.** A diff/fuzz against a side that could not be observed is dropped, never
   surfaced as fake behavior (`grasp_flow_diff` guards the unobservable side explicitly).

When you touch any renderer or tool, enforce these in the code — they are structural (the
`unobservable` field, the `meaningful` flag, the closed report vocabulary), not just prose.

## The agent seam (`app/src/main/`)

grasp is agent-agnostic. `AgentBackend` (`backends/types.ts`) is a tiny contract — `run(turn,
emit)` streams `AgentEvent`s. **Ten backends**, all registered in `agent.ts`:

- **`backends/anthropic.ts`** — the load-bearing factory `makeAnthropicBackend(opts)`: the full
  agent loop (unbounded steps — a turn ends on abort, the token `budget`, or a terminal stop) +
  the moat (SYSTEM prompt, ask-mode approval gate, post-edit fuzz nudge on `EDIT_TOOLS`) + hooks
  (PreToolUse deny / PostToolUse surfacing) + thought-level shaping + the trajectory records.
  **Change the loop once here, not per-provider.**
- **`backends/glm.ts`** — GLM, the default (`GRASP_MODEL` default `glm-5.2`); **`backends/claude.ts`**
  — native Anthropic API. Both thin configs over the factory.
- **`backends/providers.ts`** — six more thin configs on the same wire: Moonshot/Kimi, DeepSeek,
  Qwen, Xiaomi MiMo, MiniMax, BigModel. Their keys are vault-only (no env override); only
  `GRASP_<ID>_MODELS` overrides a model list.
- **`backends/openai.ts`** — OpenAI-compatible chat wire. A separate loop: any moat mechanic added
  to `anthropic.ts` (gate, nudge, hooks) **must be mirrored here** — the wire differs, the
  obligations don't.
- **`backends/claude-code.ts`** — drives the `claude` CLI (brings its own tools; needs the binary).

`shared/catalog.ts` is the model catalog (context windows, reasoning support) plus **thought
levels** (off→low→medium→high→max): both loops shape the request per provider via
`shapingFor`/`applyPathOps` — Anthropic `thinking.budget_tokens`, OpenAI `reasoning.effort` —
raising `max_tokens` above the budget so the call doesn't fail.

**Tools** (`backends/tools.ts`, ~22 built-ins + MCP): files/shell (`read_file`, `write_file`,
`edit_file`, `notebook_edit`, `list_dir`, `run_bash`, `remote_bash`), the four `grasp_*` submit
tools, `use_skill`/`Skill`, `TodoWrite`/`TodoRead`, `task` (depth-1 subagent), `explore`
(read-only research subagent), `ask_user` (structured elicitation via `approvals.ts`),
`web_fetch`/`web_search` (no-key, `web.ts`), `goal`, `ApplyPatch`. Its `SYSTEM` prompt encodes the
moat; `withProjectContext` appends the workspace's `CLAUDE.md`/`AGENTS.md` (root + nested) and the
skills listing, kept separate so project text can never override the moat. MCP servers
(`backends/mcp.ts`, stdio JSON-RPC) merge per-workspace from `~/.grasp/mcp.json`,
`~/.claude/settings.json`, `~/.agents/mcp.json` + workspace `.grasp/mcp.json`, `.mcp.json`,
`.claude/settings.json`, `.agents/mcp.json` + plugins; their tools are namespaced
`server__tool` and always gated in ask mode. `run_bash` is optionally wrapped in a macOS seatbelt
sandbox (`sandbox.ts`, env-gated, **fail-closed** — refuses to run unsandboxed if requested but
unavailable). `remote_bash` uses system ssh with `BatchMode` + `StrictHostKeyChecking` (`ssh.ts`).

**Modes** (`AgentTurn.mode`): `auto` (build), `ask` (per-tool approval on mutating/MCP tools),
`plan` (read-only; emits a `plan` event). The renderer adds a fourth composer mode, **Task** — a
pipeline owned by `App.tsx` (`taskRef` + `FlowStatus`:
`idle|planning|awaiting-approval|executing|done|failed`): plan turn → approval → "execute this
approved plan" auto turn → a verify turn (discover and run the repo's own checks, fix up to 3
rounds) → **Lifeguard** review. Lifeguard (`App.tsx` `checkChanges`) = working-tree diff vs HEAD +
a one-shot review forced to output only neutral questions ending in "?" — never verdict words.

**Hooks** (`hooks.ts`): user + project `.grasp/hooks.json` — events `UserPromptSubmit |
PreToolUse | PostToolUse | Stop`; shell commands with JSON context on stdin. A PreToolUse hook
can **deny a tool** (stdout starting `deny`, or non-zero exit). Fired from `agent.ts` and both
loops; output renders as `hook` pills in the transcript.

**One-shots** (`oneshot.ts`): single streaming model calls that power compaction, prompt-enhance,
wiki generation, Lifeguard, and the Task review. Always `stream:true` — some Anthropic-compatible
endpoints hang on `stream:false`; 120s timeout.

`agent.ts` is a thin dispatcher: picks the backend, drains the **steer queue** into the in-flight
turn, owns `stopAgent()`, and runs pre/post-turn git checkpoints (`checkpoint.ts` — visible
`grasp:` commits so HEAD = "state before this turn" and an A→B diff always has a baseline; skipped
in plan mode; **ownership law: never `git init` in a workspace that has no `.git`**).

**Streaming:** `backends/sse.ts` is the shared SSE parser. **GLM quirk:** real `input_tokens`
arrive in `message_delta.usage` (the `message_start` usage is a zero placeholder).

**IPC:** `preload/index.ts` exposes the typed `GraspApi` (`shared/types.ts`); ~60 `grasp:*`
handlers live in `index.ts`; agent progress streams over `agent:event`. Live `AgentEvent`s:
text/thinking deltas, `tool_use`/`tool_result`, `trajectory_call`, `trace`/`trace_diff`/
`fuzz_diff`/`intro`, `plan`, `hook`, `approval_request`, `elicitation_request`, `usage`, `done`,
`error` (the `dataflow`/`dataflow_diff`/`fuzz` trio is legacy). Credentials are per-provider via
Electron `safeStorage` (`vault.ts`), never plaintext; env keys (`GRASP_*_KEY`) are in-memory only.

**Persistence:** sessions, recent projects, and workflows are JSON files (mode 0600, capped) in
Electron **userData** — *not* `~/.grasp`. `~/.grasp` holds user config only: skills, commands,
plugins, `hooks.json`, `keybindings.json`, `mcp.json`. Trajectory `calls` persist inside the
`SessionRecord` and are restored on launch and session open.

## The renderer (`app/src/renderer/src/`)

`App.tsx` owns the shell: Sidebar · Conversation · a right pane with **seven tabs** (Editor
[CodeMirror], **Flow — the core surface**, Trajectory, Browser, Git, Wiki, Codemap) · xterm
terminal dock · activity rail. **Editor mode** (persisted in localStorage) flips to an
editor-forward split via **imperative panel resize** (`ImperativePanelHandle.resize()`), never a
key-remount — a remount loses Conversation input/scroll state.

- **Codemap** (`Codemap.tsx` ← `main/codemap.ts` over `grasp:codemap`) — a regex-extracted symbol
  tree, explicitly **no AI, no LSP** (caps: 100 files / 30 symbols / depth 4); double-click opens
  the file in the Editor tab.
- **Wiki** (`Wiki.tsx` ← `main/wiki.ts`) — the sole AI-prose repo doc, persisted at
  `<ws>/.grasp/wiki.md`, regenerated on demand via oneShot.
- The composer: queue + steer, thought-level control, mode picker (incl. Task), the flow-status
  badge, the Lifeguard button, context compaction, ✨ prompt-enhance, and fork-at-message.
- **Workflows** (`Workflow.tsx`, `main/workflows.ts`) are a *separate* system from the Task loop:
  user-defined durable prompt-steps with per-step status, resume-after-restart, and retry.

## Commands

The app is the product. **`npm run typecheck` is the gate — run it before every commit.**

```bash
cd app && npm install
cd app && npm run typecheck   # tsc --noEmit over tsconfig.node.json + tsconfig.web.json — THE gate
cd app && npm run dev         # electron-vite dev (desktop app + HMR)
cd app && npm run build       # build main/preload/renderer to app/out
cd app && npm run validate    # headless API harness: compiles the REAL tool registry and asserts
                              # emitted events — exists because typecheck alone once passed while
                              # a root-outcome divergence rendered as "same flow"
cd app && npm run demo:boss   # drives the RUNNING app via the .grasp-harness file bridge:
                              # real fuzz-diff render in the window + screenshot to disk
```

There is no unit-test suite; `validate` is the behavioral canary. UI changes are verified against
the real app: `main/testharness.ts` (dev-only, or `GRASP_TEST=1`) exposes loopback HTTP
`127.0.0.1:43117` and a `.grasp-harness/` file bridge (kinds `event`/`tool`/`turn`/`screenshot`/
`health`) so an external agent can drive real turns and capture real window screenshots. When you
change a renderer, produce a screenshot from real (not hand-written) data and confirm the moat
visually: no verdict words, plumbing collapsed, `unobservable` honest.

The `engine/` suite (`cd engine && make venv && make test`) is legacy — run it only when
deliberately touching that retired code.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `GRASP_WORKSPACE` | `~/GraspProjects` (auto-created) | boot workspace — never grasp's own source dir |
| `GRASP_MODEL_BASE` / `GRASP_MODEL` / `GRASP_GLM_MODELS` | `https://api.z.ai/api/anthropic` / `glm-5.2` / `glm-5.2,glm-5.1,glm-4.6,glm-4.5-air` | GLM (default backend) |
| `GRASP_API_KEY` | — | GLM key for dev/CI; in-memory, never persisted |
| `GRASP_CLAUDE_BASE` / `GRASP_CLAUDE_MODEL` / `GRASP_CLAUDE_MODELS` | `https://api.anthropic.com` / `claude-sonnet-5` / `…,claude-opus-4-8,claude-fable-5,claude-haiku-4-5-…` | Anthropic-native backend |
| `GRASP_ANTHROPIC_KEY` / `GRASP_CLAUDE_KEY` | — | Anthropic key (first one wins) |
| `GRASP_CLAUDE_CONFIG_DIR` | `~/.claude-zai` if present else `~/.claude` | routes the `claude` CLI backend's config |
| `GRASP_OPENAI_BASE` / `GRASP_OPENAI_MODELS` / `GRASP_OPENAI_KEY` | `https://api.openai.com/v1` / `gpt-5.2,gpt-5.1,gpt-4.1` / — | OpenAI-compatible backend |
| `GRASP_<ID>_MODELS` | built-in lists | model-list override for `MOONSHOT`/`DEEPSEEK`/`QWEN`/`XIAOMI`/`MINIMAX`/`BIGMODEL` (their keys are vault-only) |
| `GRASP_SANDBOX` / `GRASP_SANDBOX_NETWORK` | off / `on` | seatbelt-sandbox `run_bash` (fail-closed) / set `off` to cut sandbox network |
| `GRASP_TEST` / `GRASP_TEST_PORT` | dev-only | force-start the test harness / override its port |

## Working conventions

- **Match the shared contracts on both sides.** `shared/{trace,model,catalog,types}.ts` are
  imported by main *and* renderer. Change a shape in one place → the other must follow.
- **The Anthropic loop is shared.** Anything that applies to GLM *and* Claude *and* the six
  Layer-B providers belongs in `anthropic.ts` (`makeAnthropicBackend`), not duplicated in the thin
  configs. Moat mechanics must also be mirrored in `openai.ts` (separate wire, same obligations).
- **Name capabilities, never tools.** In skills, prompts, docs, and core checks: write "the repo's
  own test runner", "the runtime's native debug channel", "the dev environment the repo declares"
  — never package managers, task runners, test frameworks, or language names as guidance. A named
  tool anchors the agent to today's ecosystem and rots when it moves; the tracer graveyard is this
  lesson in code form. Sanctioned names: doc-discovery files (README, AGENTS.md, CLAUDE.md), git
  (grasp's own substrate), and wire-format field values.
- **Prose teaches, structure refuses.** Every agent discipline starts as skill text; the moment it
  is gamed, move it into the protocol as a closed enum or required field with a self-teaching
  rejection message (precedents: the observation channel, `appAttempt`, the report vocabulary).
- **The color system lives in `renderer/src/index.css`.** A four-layer OKLCH system with three
  schemes (Graphite default, Carbon, Daylight); the `@theme` block holds the palette (semantic
  colors, git/diff, 16-color ANSI, the accent blue). The CodeMirror editor (`Files.tsx`) carries
  its own One Dark `HighlightStyle`; the terminal and hljs code blocks read the same ANSI set.
  Keep them coherent when adding colored UI.
- **A linter reformats files between a Read and an Edit** in this workspace, which makes
  exact-match `Edit` calls fail intermittently. Prefer scripted edits (a `python3 -` heredoc that
  rewrites the file) for multi-line insertions, and always re-verify with `npm run typecheck`.
- **Never kill Electron with `pkill -f`** (it matches the launching shell) — use `pkill -x electron`.
- **Task tracking uses `bd` (beads)** — run `bd prime` for the workflow. Do not use
  TodoWrite/TaskCreate for work tracking.
