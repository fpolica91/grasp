# grasp

A local-first desktop agent for a world where the machine writes the code and the human owns what it means.

Where other agents end a change at a text diff — which tokens moved — grasp ends it at the **observed dataflow**: the real call tree, the actual values, and the A→B behavioral change of the edit. A turn finishes on a question (*"— intended?"*) rather than a verdict, so you adjudicate behavior you can see instead of grading code you can't.

It is an Electron app: a multi-provider agent (10 backends), an IDE-class shell (editor, terminal, files, browser, git graph, repo wiki), an authoring surface (queue + steer, structured questions, compaction, prompt-enhance, fork), and a live behavioral instrument that re-observes your code as the agent works. Local-first: no telemetry, no accounts, keys in your OS keychain.

---

## The idea

> An edit isn't **shown** until its behavioral consequence is **surfaced.**

Every value grasp displays is measured from a real run the agent captured, or is absent. A tooling failure shows as `unobservable` (with a reason) instead of a fabricated frame. A turn ends on a question. A behavior-preserving edit reads *"same flow — not a pass"*; a fuzz sweep reads *"K diverged out of N"* instead of *"safe."*

The ground rules:
1. **Observed, not guessed.** The nodes are ground truth; the chat is not.
2. **Facts, not verdicts.** No bug/risk/safe/pass/broken/fail labels.
3. **Legible by default.** Library plumbing is collapsed; your logic shows first.
4. **A single input proves nothing.** The honest A→B answer varies the input space.
5. **No phantom change.** A diff against a side that could not be observed is dropped.

---

## Quick start

```bash
git clone <this-repo> grasp && cd grasp
cd app && npm install
npm run dev        # electron-vite dev (desktop app + HMR)
```

Add one model key — in-app (key badge, top-right, or Settings → API keys) or env (`GRASP_API_KEY=… npm run dev`). Then prompt it: *"add a `fizzbuzz()` to lib.py and show me the flow."*

```bash
npm run typecheck   # tsc --noEmit — the gate; run before every commit
npm run build       # build main/preload/renderer → app/out
npm start           # electron-vite preview
```

There is no app unit-test suite — `typecheck` is the gate. UI changes are validated by rendering real data and screenshotting.

---

## Agents — 10 providers, one seam

grasp is agent-agnostic. Each backend implements one contract and streams the same events, so the post-editor loop is the same no matter who drives. Pick one in the provider/model picker (composer footer).

| Wire | Backend | Notes |
|---|---|---|
| Anthropic Messages | **GLM** (default), **Anthropic** (Sonnet 5 / Opus 4.8 / Fable 5 / Haiku 4.5), **Moonshot / Kimi**, **DeepSeek**, **Qwen**, **Xiaomi MiMo**, **MiniMax**, **BigModel** (智谱) | one shared owned loop; full inspector + moat prompt |
| OpenAI chat | **OpenAI** (or any compatible endpoint) | |
| CLI | **Claude Code** | drives the `claude` CLI, brings its own tools |

Keys live in Settings → API keys, encrypted via the OS keychain (`safeStorage`). Env overrides exist for dev/CI and are not persisted.

### Thought level
Reasoning models expose a thought-level control in the composer (Off → Low → Medium → High → Max). grasp shapes the request per provider — Anthropic `thinking.budget_tokens`, OpenAI `reasoning.effort` — and raises `max_tokens` above the budget so the call doesn't fail.

### Modes
- **Build** (auto) — edits freely; grasp re-observes after each mutation.
- **Ask** — pause for your approval before each workspace mutation or untrusted MCP tool.
- **Plan** — read-only; the agent proposes a plan you approve, and may ask clarifying questions first.

---

## The interface

```
┌──────────┬──────────────────────────────────┬───────────────────────────┐
│ Sidebar  │ Conversation                      │ Editor · Flow · Trajectory│
│          │   the agent turn + tool cards      │ Browser · Git · Wiki      │
│ sessions │   composer:                        │                           │
│ projects │     @files  /commands  $skills     │  (the Flow pane is where  │
│ skills   │     💭 thought  ✨ enhance          │   the observed dataflow   │
│ workflows│     ⚡steer / queue while busy      │   lives — the core)       │
├──────────┴──────────────────────────────────┴───────────────────────────┤
│ Terminal dock (xterm)                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Conversation** — markdown + syntax-highlighted code blocks (copy/collapse), tool calls as cards, plan cards, approval gates, structured question cards, and nested subagent activity.
- **Right pane — six tabs:**
  - **Editor** — CodeMirror: file tree, multi-tab, split view, side-by-side diff, in the grasp palette.
  - **Flow** — the observed dataflow: real call tree, A→B `TraceDiff`, differential `FuzzDiff`.
  - **Trajectory** — a request/response inspector for every model call (`#N · model · source · time · duration`), expandable into Input / System / Reasoning / Tools / Output. Persists across restarts.
  - **Browser** — in-app webview pane.
  - **Git** — a lane-based commit graph (colored rails, merge connectors, branch-head chips) with safe actions (fetch / pull / push / stage / commit / branch / merge / rebase).
  - **Wiki** — an AI-generated single-page repo doc (overview, structure, run, test, key entrypoints), persisted to `.grasp/wiki.md`; regenerate on demand.
- **Terminal** — an xterm dock, themed to match.

Open in your editor — the split button launches the workspace in VS Code, Cursor, Zed, Trae, Sublime, JetBrains, Warp, Ghostty, and more (auto-detected, brand icons).

---

## The authoring surface

The composer is built for driving a running agent, not waiting on one:

- **Queue + Steer** — keep typing while the agent runs. Enter queues a follow-up (sent when the turn ends); ⚡ Steer injects it into the in-flight turn at the next step.
- **Elicitation** — when the agent must choose, it asks a structured question (radio options + your own answer) instead of guessing; a question card renders inline.
- **Context compaction** — a token meter (used vs the model's context window) plus one-click Compact, which summarizes the conversation into a handover for the next turn.
- **Prompt-enhance** — ✨ one-shot rewrites your prompt for clarity into the composer.
- **Message fork** — branch the conversation at any of your messages to try a different direction (non-destructive; autosave keeps the original).

---

## The Flow (the core feature)

The agent surfaces a flow through three pure, no-execution tools (large traces pass by file path, not inline):

- **`grasp_flow`** — submit one observed `TraceDoc` (a real call tree of frames: args → calls → return/threw + source line + timing).
- **`grasp_flow_diff`** — submit old + new; grasp renders the A→B change.
- **`grasp_fuzz_diff`** — submit a `cases_file` of `{input, old, new}`; grasp diffs each pair and surfaces only the inputs where behavior diverged.

A bug that only breaks inputs you didn't try reads as "same flow" on the one input you picked — that's why the fuzz exists. After a mutating edit the agent is nudged to fuzz-diff before concluding. grasp executes nothing itself to produce these — the agent captures and submits; grasp validates and renders.

### The agent's toolbelt
Files and shell (`read_file`, `write_file`, `edit_file`, `list_dir`, `run_bash`, remote `remote_bash`), `web_fetch` + `web_search` (no-key, DuckDuckGo), `explore` (a read-only research subagent), `Skill` (load a skill mid-turn), `goal` (a persistent objective tracker), `ApplyPatch` (Claude-Code-style multi-file patch), `task` (depth-1 delegation), `TodoWrite`/`TodoRead`, `ask_user` (elicitation), plus the three `grasp_*` submit tools.

---

## Extensibility

Everything lives under `~/.grasp/` (reveal any surface via Settings → ⋯):

- **Skills** — directory-format skills with progressive disclosure; enable/disable per workspace. (`$` in the composer, or the `Skill` tool.)
- **Slash commands** — project or user commands; type `/`.
- **MCP servers** — config read from several sources so a workspace set up for any agent works as-is: `.grasp/mcp.json`, `.mcp.json`, `.claude/settings.json`, `.agents/mcp.json` (user + project). Stdio; ask-mode gates untrusted tools.
- **Plugins** — `.grasp-plugin` packages bundling skills + MCP. Install from the marketplace or a URL.
- **Memory files** — project instructions are read from `CLAUDE.md` / `AGENTS.md` at the root and nested (`.claude/CLAUDE.md`, `.agents/AGENTS.md`, `.zcode/AGENTS.md`).
- **Keybindings** — file-driven, editable in `keybindings.json`.
- **Workflows** — durable, ordered prompt-steps run one at a time against a carried conversation; resumes from the interrupted step after a restart.

### Remote
SSH into a remote box and run the agent there (system SSH, strict host-key verification). Docker remote is stubbed for future work.

---

## Themes

A four-layer OKLCH design system, three selectable schemes from the sidebar footer or Settings → Appearance: **Graphite** (default dark), **Carbon** (neutral-900 / sky), **Daylight** (light).

One color system across the editor, terminal, code blocks, and the node-graph palette the Flow view renders in — so the call tree, skills, commands, subagents, and sessions each get their own lane color.

---

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `GRASP_WORKSPACE` | `process.cwd()` | default agent workspace at boot |
| `GRASP_API_KEY` | — | GLM key (dev/CI; in-memory, not persisted) |
| `GRASP_MODEL_BASE` / `GRASP_MODEL` / `GRASP_GLM_MODELS` | `https://api.z.ai/api/anthropic` / `glm-5.2` / `glm-5.2,…` | GLM endpoint + model list |
| `GRASP_ANTHROPIC_KEY` / `GRASP_CLAUDE_*` | — / Anthropic defaults | Claude-native provider |
| `GRASP_OPENAI_KEY` / `GRASP_OPENAI_BASE` / `GRASP_OPENAI_MODELS` | — / OpenAI defaults | OpenAI-compatible provider |
| `GRASP_<ID>_MODELS` | built-in lists | override the model list for any provider (`MOONSHOT`, `DEEPSEEK`, `QWEN`, `XIAOMI`, `MINIMAX`, `BIGMODEL`) |

In-app credentials are per-provider, encrypted with Electron `safeStorage` (OS keychain / libsecret / DPAPI). Env overrides are honored in-memory only.

---

## Architecture (in one line)

> grasp = UI + nodes + skill. The agent is the compiler.

grasp core supplies three things:
1. **The nodes** — the Trace protocol (`app/src/shared/trace.ts`): a `TraceDoc` is a real call tree. `validateTrace` rejects malformed submissions; a tooling failure is the `unobservable` field, not a fabricated frame.
2. **The UI** — `FlowView` renders a `TraceDoc` as an interactive call tree, an A→B `TraceDiff`, and a differential `FuzzDiff`. It collapses frames the agent marks `meaningful:false` — grasp hardcodes no classifier; the agent supplies the meaning.
3. **The agent seam** — `AgentBackend` (`app/src/main/backends/types.ts`): a small contract (`run(turn, emit)` streams `AgentEvent`s), implemented across two wires (Anthropic Messages + OpenAI chat) and the Claude-Code CLI.

A new codebase costs zero grasp changes — the agent absorbs the variation.

```
app/
  src/main/        agent dispatcher, backends (glm/claude/claude-code/openai + 6 providers),
                   vault, sessions, skills, plugins, mcp, launcher, ssh, git, wiki, web, terminal
  src/renderer/    the shell: sidebar, conversation, FlowView, editor, trajectory, git graph, wiki
  src/shared/      the Trace protocol + catalog + shared types (imported by both sides)
docs/thesis.md     the anti-drift north star — read before non-trivial changes
```

---

## Scope

grasp does not grade — it surfaces behavior and asks. It's local-first: no accounts, billing, telemetry, or auto-updater (see `docs/thesis.md`). It runs none of your code itself — the agent runs it and captures the flow; grasp validates and renders.

---

## Status

`0.1.0` — active development. The desktop shell, 10-provider agent, observed-dataflow instrument, model-trajectory inspector, git graph, repo wiki, the authoring surface, and the extensibility stack (skills/plugins/MCP/commands/keybindings/workflows) are all live.

## License

All rights reserved (private project).
