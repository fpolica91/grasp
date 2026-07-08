# grasp — the post-editor

A desktop review surface for a world where an **agent writes the code** and the **human owns what it *means***.

Instead of a text diff (which tokens moved), grasp shows the **observed dataflow** — the real call tree, the actual values, and the A→B behavioral change of an edit — and ends in a neutral question (*"— intended?"*), **never a verdict**. You adjudicate behavior you can see instead of grading code you can't.

grasp is a full Electron desktop app: a multi-provider agent, an IDE-class shell (editor, terminal, files, browser), and a live behavioral instrument that re-observes your code as the agent works.

---

## The idea

> An edit is not **shown** until its behavioral consequence is **surfaced**.

Every value grasp displays is **measured from a real run** the agent captured, or absent. A tooling failure shows as `unobservable` (with a reason) — *never* a fabricated frame. Output ends in a question. A behavior-preserving edit reads *"same flow — not a pass"*; a fuzz sweep reads *"K diverged out of N"*, **never "safe"**.

The non-negotiables:
1. **Observed, never guessed.** The nodes are ground truth; the chat is not.
2. **Facts, not verdicts.** No bug/risk/safe/pass/broken/fail — ever.
3. **Legible by default.** Library plumbing is collapsed; *your* logic shows first.
4. **A single input proves nothing.** The honest A→B answer varies the input space.
5. **No phantom change.** A diff against a side that could not be observed is dropped.

---

## Quick start

```bash
git clone <this-repo> grasp && cd grasp
cd app && npm install
npm run dev        # electron-vite dev (desktop app + HMR)
```

Add a model key (one provider is enough to start):
- **In-app:** click the key badge (top-right) → paste a key. Or **Settings → API keys**.
- **Env (dev/CI):** `GRASP_API_KEY=… npm run dev`

Then type a prompt: *"add a fizzbuzz() to lib.py and show me the flow."*

### Build / run

```bash
cd app
npm run typecheck   # tsc --noEmit — THE gate; run before every commit
npm run build       # build main/preload/renderer to app/out
npm start           # electron-vite preview (run the built app)
```

There is no app unit-test suite — **`typecheck` is the gate.** UI changes are validated by rendering real data and screenshotting under a virtual framebuffer.

---

## Agents (pick your provider)

grasp is agent-agnostic. Every backend implements one seam and streams the same events, so the post-editor loop is identical no matter which agent drives it. Choose one in the **provider/model picker** (bottom of the composer).

| Backend | What it is | Key |
|---|---|---|
| **GLM** | Native Anthropic-Messages wire to GLM (default) | z.ai API key |
| **Claude** | Native Anthropic API (Sonnet 5 / Opus 4.8 / Fable 5 / Haiku 4.5) — no CLI | `sk-ant-…` |
| **Claude Code** | Drives the `claude` CLI (brings its own tools) | the CLI's own auth |
| **OpenAI** | Any OpenAI-compatible chat endpoint | `sk-…` |

Set keys under **Settings → API keys** (encrypted via the OS keychain — never written in the clear). Env overrides exist for dev/CI and are never persisted.

### Agent modes
- **Build** (auto) — the agent edits freely; grasp re-observes after each mutation.
- **Ask** — pause for your approval before each workspace mutation or untrusted MCP tool.
- **Plan** — read-only; the agent proposes a plan you approve before it touches anything.

---

## The interface

```
┌──────────┬─────────────────────────────┬──────────────────────┐
│ Sidebar  │ Conversation                 │ Editor / Flow /      │
│          │  (the agent turn)            │   Trajectory /       │
│ sessions │  composer: @files /commands  │   Browser            │
│ projects │   $skills  #related         │                      │
│ skills   │                              │                      │
│ workflows│                              │                      │
├──────────┴─────────────────────────────┴──────────────────────┤
│ Terminal dock (xterm)                                         │
└───────────────────────────────────────────────────────────────┘
```

- **Sidebar** — sessions (auto-saved, fork/rename/delete, last session restored on launch), projects, skills, and workflows. Sort control, theme dots, and a project switcher live in the footer.
- **Conversation** — markdown rendering with syntax-highlighted code blocks (copy/collapse), tool calls as clean cards, plan cards, approval gates, and nested subagent activity. The composer takes `@` for files/folders, `/` for commands, `$` for skills.
- **Right pane** — four tabs:
  - **Editor** — a real CodeMirror editor: file tree, multi-tab, split view, and a side-by-side diff. Syntax-highlighted in the grasp palette.
  - **Flow** — the observed dataflow. After the agent edits, grasp re-observes the watched entrypoint and renders the real call tree, the A→B `TraceDiff`, and the differential `FuzzDiff`.
  - **Trajectory** — a request/response inspector for every model call the agent made: `#N · model · Main session · <time> · <duration>`, each expandable into Input / System / Reasoning / Tool call / Output / Tool result. Persists across restarts.
  - **Browser** — an in-app webview pane.
- **Terminal** — a real xterm dock in the workspace, themed to match.

### Open in your editor
The split button in the conversation header launches the workspace in your editor of choice — **VS Code, Cursor, Zed, Trae, Sublime, JetBrains, Warp, Ghostty**, and more (auto-detected, with brand icons).

---

## The Flow (the live instrument)

This is the heart of grasp. The agent surfaces a flow through three pure, no-execution tools (large traces pass by **file path**, not inline):

- **`grasp_flow`** — submit one observed `TraceDoc` (a real call tree of frames: args → calls → return/threw + source line + timing).
- **`grasp_flow_diff`** — submit old + new; grasp renders the A→B change.
- **`grasp_fuzz_diff`** — submit a `cases_file` of `{input, old, new}`; grasp diffs each pair and surfaces **only the inputs where behavior diverged**.

A bug that only breaks inputs you didn't try reads as "same flow" on the one input you picked — that's why the fuzz exists. After a mutating edit, the agent is nudged to fuzz-diff before concluding. grasp **executes nothing itself** to produce these — the agent captures and submits; grasp validates and renders.

---

## Extensibility

Everything lives under `~/.grasp/` (reveal any surface via **Settings → ⋯**):

- **Skills** — directory-format skills with progressive disclosure; enable/disable per workspace. Type `$` in the composer.
- **Slash commands** — project or user commands; type `/`.
- **MCP servers** — configure stdio MCP servers in `mcp.json`; their tools augment the agent (ask-mode gates untrusted ones).
- **Plugins** — `.grasp-plugin` packages bundling skills + MCP. Install from the marketplace or a URL.
- **Keybindings** — file-driven, editable in `keybindings.json`.
- **Workflows** — durable, ordered prompt-steps run one at a time against a carried conversation; resumes from the interrupted step after a restart.

### Remote
**SSH** into a remote box and run the agent there (system SSH, strict host-key verification). Docker remote is stubbed for future work.

---

## Themes

Two schemes, toggleable from the sidebar footer or **Settings → Appearance**:
- **Dark** — the default deep-gray palette with a signature blue accent, full 16-color ANSI terminal palette, and semantic/git/diff colors.
- **Light** — a matching light scheme.

The editor, terminal, and code blocks all share one color system.

---

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `GRASP_WORKSPACE` | `process.cwd()` | default agent workspace at boot |
| `GRASP_API_KEY` | — | GLM key (dev/CI; in-memory, never persisted) |
| `GRASP_MODEL_BASE` | `https://api.z.ai/api/anthropic` | GLM endpoint |
| `GRASP_MODEL` | `glm-5.2` | GLM default model |
| `GRASP_GLM_MODELS` | `glm-5.2,glm-5.1,glm-4.6,glm-4.5-air` | GLM model list |
| `GRASP_ANTHROPIC_KEY` / `GRASP_CLAUDE_KEY` | — | Anthropic key (dev/CI) |
| `GRASP_CLAUDE_BASE` | `https://api.anthropic.com` | Claude endpoint (or proxy) |
| `GRASP_CLAUDE_MODEL` | `claude-sonnet-5` | Claude default model |
| `GRASP_CLAUDE_MODELS` | `claude-sonnet-5,claude-opus-4-8,claude-fable-5,claude-haiku-4-5-20251001` | Claude model list |
| `GRASP_OPENAI_KEY` | — | OpenAI key (dev/CI) |
| `GRASP_OPENAI_BASE` / `GRASP_OPENAI_MODELS` | OpenAI defaults | OpenAI-compatible endpoint + model list |

Credentials set in-app are per-provider, encrypted with Electron `safeStorage` (OS keychain / libsecret / DPAPI). Env overrides are honored in-memory only.

---

## Architecture (in one line)

> **grasp = UI + nodes + skill. The agent is the compiler.**

grasp core supplies three things:
1. **The nodes** — the Trace protocol (`app/src/shared/trace.ts`): a `TraceDoc` is a real call tree. `validateTrace` rejects malformed submissions; a tooling failure is the `unobservable` field, never a fabricated frame.
2. **The UI** — `FlowView` renders a `TraceDoc` as an interactive call tree, an A→B `TraceDiff`, and a differential `FuzzDiff`. It collapses frames the agent marks `meaningful:false` — grasp hardcodes no classifier; the agent supplies the meaning.
3. **The agent seam** — `AgentBackend` (`app/src/main/backends/types.ts`): a tiny contract (`run(turn, emit)` streams `AgentEvent`s). GLM, Claude, Claude Code, and OpenAI each implement it.

A new codebase costs **zero** grasp changes — the agent absorbs the variation.

```
app/
  src/main/        agent dispatcher, backends (glm/claude/claude-code/openai),
                   vault, sessions, skills, plugins, mcp, launcher, ssh, terminal
  src/renderer/    the shell: sidebar, conversation, FlowView, editor, trajectory
  src/shared/      the Trace protocol + shared types (imported by both sides)
docs/thesis.md     the anti-drift north star — read before non-trivial changes
```

---

## Status

`0.1.0` — active development. The desktop shell, multi-provider agent, observed-dataflow instrument, model-trajectory inspector, and extensibility surface (skills/plugins/MCP/commands/keybindings/workflows) are all live.

## License

All rights reserved (private project).
