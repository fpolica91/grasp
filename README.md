# grasp — the post-editor

A desktop review surface for a world where an **agent writes the code** and the **human owns what it *means***.

grasp comes in two layers:
- **v1 — observe.** Instead of a text diff, grasp shows the **observed dataflow** — the real call tree, the actual values, and the A→B behavioral change of an edit — and ends in a neutral question (*"— intended?"*), **never a verdict**.
- **v2 — judge, and remember.** A standing **behavior model** (`.grasp/model.yaml`) states what the human requires; grasp checks every change against it and renders a **Verification Report** — `conforms` / `violated` / `untested` / `novel`. Covered behavior conforms silently or violates loudly; only **novel** behavior asks. Adjudications are *remembered* — the human never re-judges the same behavior twice.

Throughout, the rule is absolute: **the machine never asserts.** No "proven", "safe", "pass", "fixed", "bug". Every value is measured from a real run; the only judgments in the system are the human's, cached.

> **Read [`docs/thesis.md`](docs/thesis.md)** (the v1 north star) and **[`docs/spec-v2.md`](docs/spec-v2.md)** (the v2 behavior-model spec) before non-trivial work.

---

## The idea

> An edit is not **shown** until its behavioral consequence is **surfaced.**

Every value grasp displays is **measured from a real run** the agent captured, or absent. A tooling failure shows as `unobservable` (with a reason) — *never* a fabricated frame. A behavior-preserving edit reads *"same flow — not a pass"*; a fuzz sweep reads *"K diverged out of N"*, **never "safe"**.

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

### Build / run / check

```bash
cd app
npm run typecheck   # tsc --noEmit — THE gate; run before every commit
npm run build       # build main/preload/renderer to app/out
npm start           # electron-vite preview (run the built app)
npm run validate    # headless v2 assertions against the real registry (17 checks)
npm run demo:boss   # the boss demo (drives a full turn via the harness)
```

There is no app unit-test suite — **`typecheck` + `npm run validate` are the gates.** UI changes are validated by rendering real data and screenshotting under a virtual framebuffer (or driving the in-app harness — see below).

---

## The behavior model (v2)

The durable, git-tracked statement of what the human requires of a codebase. It lives at the **owning repo's root** as `.grasp/model.yaml`:

```yaml
grasp_model_version: 1
feature: tasks
states:
  task: [active, completed, deleted]
rules:
  - id: R1
    text: only the owner may edit a task
    origin: authored            # authored | ratified
    check:                      # compiled, machine-checkable form (the claim DSL)
      scenario: edit_task
      where: { op: cmpf, path: actor.id, rel: '!=', other: task.owner_id }
      expect: { status: rejected }
  - id: R2
    text: a deleted task can never be edited
    origin: ratified            # sedimented from a real run the human stamped
    ratified: 2026-07-07
examples:
  - label: owner edits own active task
    scenario: edit_task
    input: { actor: u1, task: { owner_id: u1, state: active } }
    expect: { status: returned }
```

- **`states`** — the axes fuzz varies.
- **`rules`** — the always/nevers. Each carries its human `text` + a compiled `check`. `origin: authored` (human wrote it) or `ratified` (derived from observation, human stamped it). Nobody has to write a complete spec.
- **`examples`** — named scenarios that must keep holding; the sediment of adjudications.

### The Verification Report (the primary surface)

After any change, the human reads one row per rule and per example:

```
R1  only the owner may edit         conforms   (58 observed cases, 0 counterexamples)
R2  deleted tasks cannot be edited  violated   (3 counterexamples — ratified 2026-07-07)
E1  owner edits own active task     conforms
—   novel: edit while completed now returns partial object — intended?
```

**Four words, closed and deterministic:**
- **conforms** — no counterexample among the N observed cases. Always carries N. Never "safe".
- **violated** — a counterexample to a rule the human authored or ratified; the citation names the rule.
- **untested** — no observed case covers the rule this run.
- **novel** — observed behavior not covered by any rule. The *only* category that ends in *"— intended?"*. Your answer **ratifies** it into the model (sediment) or triggers repair.

The economics of "— intended?" invert: covered behavior is silent or loud; only novelty asks.

### The loop
```
turn start   agent loads recipe (how to run) + model (what must hold)
generate     the edit is produced TOWARD the model — rules are context
check        scenarios derived from rules + states + examples; grasp recomputes every outcome
report       conforms / violated / untested / novel
adjudicate   only novel rows ask → "intended" ratifies; "not intended" → repair
repair       violations invite SPEC PATCHING first (tighten/add a rule) — code change is the fallback
```

---

## Reading order (strictly layered)

Each layer is one click from the evidence below it. No layer contains prose the layer below cannot substantiate.

1. **Report** — rule × status × evidence count. The daily artifact.
2. **Scenario row** — the outcome delta in domain words.
3. **Claim card** — the checked generalization (`where` / `effect`, support, straddle).
4. **Flow** — the call tree with lineage-rendered values. **The debugger** (all of v1 lives here: object deltas, references, plumbing collapse, the A→B `TraceDiff`, the differential `FuzzDiff`).
5. **Source** — click-through from any frame.

---

## Agents (pick your provider)

grasp is agent-agnostic. Every backend implements one seam and streams the same events, so the loop is identical no matter which agent drives it.

| Backend | What it is | Key |
|---|---|---|
| **GLM** | Native Anthropic-Messages wire to GLM (default) | z.ai API key |
| **Claude** | Native Anthropic API (Sonnet 5 / Opus 4.8 / Fable 5 / Haiku 4.5) — no CLI | `sk-ant-…` |
| **Claude Code** | Drives the `claude` CLI (brings its own tools) | the CLI's own auth |
| **OpenAI** | Any OpenAI-compatible chat endpoint | `sk-…` |

Set keys under **Settings → API keys** (encrypted via the OS keychain — never written in the clear).

### Agent modes
- **Build** (auto) — the agent edits freely; grasp re-observes after each mutation.
- **Ask** — pause for your approval before each workspace mutation or untrusted MCP tool.
- **Plan** — read-only; the agent proposes a plan you approve before it touches anything.

---

## The interface

- **Sidebar** — sessions (auto-saved, fork/rename/delete, last session restored on launch), projects, skills, workflows. Sort control, theme dots, and a project switcher live in the footer.
- **Conversation** — markdown rendering with syntax-highlighted code blocks (copy/collapse), tool calls as clean cards, plan cards, approval gates, and nested subagent activity. The composer takes `@` for files/folders, `/` for commands, `$` for skills.
- **Right pane** — the surfaces above (Report → … → Flow → Source), plus:
  - **Editor** — a real CodeMirror editor: file tree, multi-tab, split view, side-by-side diff. Syntax-highlighted with a Zed-style One Dark palette.
  - **Trajectory** — a request/response inspector for every model call the agent made: `#N · model · source · <time> · <duration>`, each expandable into Input / Reasoning / Tool call / Output / Tool result. Persists across restarts.
  - **Browser** — an in-app webview pane.
- **Terminal** — a real xterm dock in the workspace.
- **Open in your editor** — a split button launches the workspace in **VS Code, Cursor, Zed, Trae, Sublime, JetBrains, Warp, Ghostty**, and more (auto-detected, with brand icons).

---

## The Flow (the v1 instrument — now the debugger layer)

The agent surfaces behavior through three pure, no-execution tools (large traces pass by **file path**, not inline):

- **`grasp_flow`** — submit one observed `TraceDoc` (a real call tree of frames: args → calls → return/threw + source line + timing).
- **`grasp_flow_diff`** — submit old + new; grasp renders the A→B change.
- **`grasp_fuzz_diff`** — submit a `cases_file` of `{input, old, new}`; grasp diffs each pair and surfaces **only the inputs where behavior diverged**. In v2 this same machinery checks each rule.

grasp **executes nothing itself** — the agent captures and submits; grasp validates, cross-tabulates, and renders.

---

## Test harness (automation)

An **external agent or script can drive and inspect grasp** so the human never has to be the test rig. Two transports, one handler set:

- **HTTP** on `127.0.0.1:$GRASP_TEST_PORT` (default `43117`) — `POST /event`, `POST /tool`, `POST /turn` (a full chat-equivalent turn), `POST /screenshot`, `GET /health`.
- **File bridge** at `$GRASP_HARNESS_DIR` (default `<cwd>/.grasp-harness/`) — write `cmd.json {id, kind, payload}`, read `out-<id>.json`. For callers that can only reach the filesystem.

Screenshots capture the real window to a PNG on disk, so *"does it look right"* is checkable without a human. **Dev-only:** active when the app is unpackaged, or `GRASP_TEST=1` in production. `npm run validate` and `npm run demo:boss` drive this.

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
**SSH** into a remote box and run the agent there (system SSH, strict host-key verification).

---

## Themes

Two schemes, toggleable from the sidebar footer or **Settings → Appearance**:
- **Dark** — deep-gray with a signature blue accent, full 16-color ANSI terminal palette, and semantic/git/diff colors.
- **Light** — a matching light scheme.

The editor (One Dark), terminal, and code blocks all share one color system.

---

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `GRASP_WORKSPACE` | `process.cwd()` | default agent workspace at boot |
| `GRASP_API_KEY` | — | GLM key (dev/CI; in-memory, never persisted) |
| `GRASP_MODEL_BASE` | `https://api.z.ai/api/anthropic` | GLM endpoint |
| `GRASP_MODEL` / `GRASP_GLM_MODELS` | `glm-5.2` / `glm-5.2,glm-5.1,glm-4.6,glm-4.5-air` | GLM model + list |
| `GRASP_ANTHROPIC_KEY` / `GRASP_CLAUDE_KEY` | — | Anthropic key (dev/CI) |
| `GRASP_CLAUDE_BASE` | `https://api.anthropic.com` | Claude endpoint (or proxy) |
| `GRASP_CLAUDE_MODEL` / `GRASP_CLAUDE_MODELS` | `claude-sonnet-5` / `claude-sonnet-5,claude-opus-4-8,claude-fable-5,claude-haiku-4-5-20251001` | Claude model + list |
| `GRASP_OPENAI_KEY` | — | OpenAI key (dev/CI) |
| `GRASP_OPENAI_BASE` / `GRASP_OPENAI_MODELS` | OpenAI defaults | OpenAI-compatible endpoint + model list |
| `GRASP_TEST` | — | set `1` to enable the test harness in a packaged app |
| `GRASP_TEST_PORT` | `43117` | harness HTTP port |
| `GRASP_HARNESS_DIR` | `<cwd>/.grasp-harness` | harness file-bridge directory |

Credentials set in-app are per-provider, encrypted with Electron `safeStorage` (OS keychain / libsecret / DPAPI). Env overrides are honored in-memory only.

---

## Architecture

> **grasp = UI + nodes + skill. The agent is the compiler.**

grasp core supplies three things:
1. **The nodes** — the Trace protocol (`app/src/shared/trace.ts`): a `TraceDoc` is a real call tree. `validateTrace` rejects malformed submissions; a tooling failure is the `unobservable` field. In v2 the same protocol carries scenario/claim/rule objects (`app/src/shared/model.ts`).
2. **The UI** — surfaces that render observed behavior + the verification report. It collapses frames the agent marks `meaningful:false` — grasp hardcodes no classifier; the agent supplies the meaning.
3. **The agent seam** — `AgentBackend` (`app/src/main/backends/types.ts`): `run(turn, emit)` streams `AgentEvent`s. GLM and Claude share one Anthropic-Messages loop (`backends/anthropic.ts`, `makeAnthropicBackend`); OpenAI and the Claude Code CLI are separate.

A new codebase costs **zero** grasp changes — the model + recipe live in the target repo, not in grasp; the agent absorbs the variation.

```
app/
  src/main/        agent dispatcher, backends (anthropic factory + glm/claude/
                   claude-code/openai), vault, sessions, skills, plugins, mcp,
                   launcher, ssh, terminal, checkpoint, testharness
  src/renderer/    the shell: sidebar, conversation, FlowView + report surfaces,
                   editor, trajectory, terminal
  src/shared/      trace.ts + model.ts + types.ts (imported by both sides)
docs/thesis.md     v1 north star — observed dataflow, the moat
docs/spec-v2.md    v2 behavior-model spec — the durable judgment layer
```

---

## Status

v1 (observe) and v2 (judge + remember) are implemented and shipped. The desktop shell, four-provider agent, observed-dataflow instrument, model-trajectory inspector, verification report, and extensibility surface (skills/plugins/MCP/commands/keybindings/workflows) are all live.

## License

All rights reserved (private project).
