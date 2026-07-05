# grasp — UX / Feature Gap Report (vs the ZCode RE)
> framing: grasp just shipped an extensibility surface (skills, MCP, commands, keybindings, plugins, SSH, workflow/session depth) but the user reports the UX still hides or misses things. This doc is the prioritized fix list.

Date: 2026-07-05 · Audience: the engineer who fixes these next

---

## 1. Verdict

- The feeling ("UX still leaves things to be desired, features hard to reach") is real and maps to **three structural defects, not styling**: (1) **collapsed command surfaces** — ZCode's two entry ramps (`/` slash menu + Cmd+K palette) were merged into one and the `/` menu was dropped, so commands/skills are invisible unless the user opens the palette, and parameterized commands are silently degraded; (2) **Settings buries extensibility** — Commands, Keybindings, SSH, and a usable MCP editor are all filesystem-only, and even the things Settings *can* list (Skills, Plugins, MCP) are read/toggle/install-only with no create/edit/delete/env; (3) **the moat is reachable by accident** — the Flow pane auto-collapses with no signal, built-in Flow tool calls render as opaque raw-name chips in the chat, and the "live" pill lies on the default (flowAuto-off) setting.
- **Most serious by severity:** (a) **no `/` slash menu** in the composer (`critical`, two areas); (b) **collapsed side pane silently swallows the Flow** — the entire product thesis disappears with zero feedback (`critical`); (c) **MCP is nearly unmanageable from the UI** — add-only, drops `env`, no edit/delete/health/tool inspection (`critical`, two areas); (d) **`describe()` case labels are stale** — every built-in `grasp_flow` call renders as a raw token chip with no argument, so the moat is illegible *inside* the chat on every turn (high, one-line-per-case fix, single highest-leverage patch).
- **Two verifier rejections applied** (do NOT fix as originally framed): (1) "PROVIDERS drifted from BACKENDS because claude-code has no key row" is **false** — claude-code self-authenticates via the real `claude` CLI / `~/.claude-zai` and never calls `getKey/setKey`, so `PROVIDERS=[glm,openai]` is correct; the real gap is no model-config tab + unpersisted `agentMode`/`budget`. (2) "skills.ts drops a skill on description length / parse failure" is **false** — it sets a non-blocking `warning`, never drops; the fix is to **surface the existing `Skill.warning` field** in Settings, not invent a dropped-skills array.
- **One verifier rejection of a claimed security hole:** "MCP tools bypass Ask-mode approval" is **false** — `glm.ts:211-214` and `openai.ts:215-217` both gate MCP tools via an explicit `|| isMcpTool` clause ("untrusted MCP tool"). The valid residual (no per-tool risk gradation → read-only `git log` gates like `rm -rf`) is refiled at correct lower severity under medium.
- **Eight material items the per-area audits missed** are folded in below: SSH has **zero** Settings UI; **no way to clear a stored key** from the keychain; **sessions can't be renamed** (auto-derived, immutable); **extension lists never refresh** after creation (breaks the skill-creator loop in practice); **`describe()` staleness** (the Flow-chip rename bug); the **panebbar "live" pill is actively false** on the default setting (thesis-integrity); **no reveal-in-file-manager** for file-driven dirs; **plugin rows hide** what was actually installed.
- **Honest takeaway:** grasp correctly ripped ZCode's telemetry/router/token-diff-pane and re-owned the agent loop, and is *ahead* of ZCode on credentials (safeStorage), SSH host-key security, file-driven **rebindable** keybindings, and the two hardest ideas (skills progressive disclosure + commands↔skills unification). It under-ported the **discoverability + extensibility-management** layer — the parts that make ZCode feel effortless rather than capable-but-buried.

---

## 2. Gaps by severity

### Critical

**C1. No `/` slash menu in the composer — commands and skills are hidden behind Cmd+K, and parameterized commands are silently broken even when found** *(discoverability + extensibility-mgmt)*
- **What's wrong:** The composer (`app/src/renderer/src/components/Conversation.tsx:390-402`) is a plain textarea with zero `/` detection (grep for `slashMenu`/`startsWith('/')` returns nothing). Slash commands surface ONLY as `/name` items inside the Cmd+K palette (`App.tsx:507-519`), and `App.tsx:514-515` explicitly comments `'$ARGUMENTS/$N aren't reachable from the palette yet — strip them'` and runs `c.body.replace(/\$ARGUMENTS/g,'').replace(/\$\d+/g,'')`. So a user who never opens Cmd+K will never discover commands/skills, and `/review $ARGUMENTS` is degraded to its body with the argument dropped.
- **Falls short of RE idea:** EXTENSIBILITY-RE §4.1 / §5.8 — *two* command surfaces (a `/` menu as the primary in-composer type-to-filter ramp WITH argument hints, plus a Cmd+K palette for app/UI commands). grasp merged them into one and dropped the in-composer ramp.
- **Fix:** Add an inline slash-menu to the composer: when the textarea value starts with `/`, render a popover filtering the already-loaded `commands` + enabled `skills` (both already in App state). On select, if the body has `$ARGUMENTS`/`$N`, prompt for args inline before send. Reuse the existing body-templating in `app/src/main/commands.ts`. Keep Cmd+K for app/view commands.
- **Effort:** M

**C2. Collapsed side pane silently swallows the Flow — grasp's whole reason to exist disappears** *(agent-loop)*
- **What's wrong:** `App.tsx:93-95` runs `useEffect(() => { if (surface) setRightTab('flow') }, [surface])` — it flips the tab but **never calls `rightRef.current.expand()`**. The right Panel is collapsible to size 0 (`collapsedSize=0`, `App.tsx:592`) via the panebar ✕ (`App.tsx:613`). The pulse "live" dot lives *inside* the panebar (`App.tsx:607-612`), so it's hidden when collapsed, and the activity-rail Flow icon gets no badge (`App.tsx:738`). No toast. The entire moat is invisible until the user manually re-opens the pane.
- **Fix:** In the surface `useEffect`, also call `rightRef.current.expand()` when `isCollapsed()`. When a surface arrives while collapsed, show a transient toast / pulsing badge on the activity-rail Flow icon ("new Flow — click to view"). Single highest-leverage fix in the conversation UX.
- **Effort:** S

**C3. MCP servers are nearly unmanageable from the UI — add silently drops `env`, mangles quoted args; no edit, no delete, no source attribution, no health, no tool inspection** *(settings + extensibility-mgmt)*
- **What's wrong:** The Settings MCP tab (`app/src/renderer/src/components/Settings.tsx:180-196`) only has an Add form (name/command/args). `app/src/main/index.ts:86-90` builds `cfg = {command, args}` and **drops `env` entirely** even though `McpServerConfig` supports it (`app/src/main/backends/mcp.ts:17`), the loader preserves it (`mcp.ts:81`), and the file header says *"Secrets in a config's env block ride in process env."* Args are whitespace-split (`index.ts:87` `args.trim().split(/\s+/)`), mangling any arg with spaces/quotes. `GraspApi` (`app/src/shared/types.ts:274-275`) exposes **only `saveMcpServer`** — no `deleteMcpServer`/`updateMcpServer`/`mcpTools`/`mcpStatus`. Every row shows a hardcoded `'mcp'` badge regardless of source (`Settings.tsx:171`). `McpRegistry.start().errors` (`mcp.ts:216-235`) is captured but thrown away (`tools.ts:139 await reg.start(workspace)` — return value ignored), so a server that fails to start looks healthy. `mcp.ts` is **stdio-only** (always `spawn`, no url/headers/http/sse). There is no `/mcp` command and no UI to list the live tools a server exposes — the agent sees them; the human is blind.
- **Falls short of RE idea:** EXTENSIBILITY-RE §5.2 / §2.1 — typed `userConfig`→ENV bridge with working defaults (install a 23-tool android-emulator MCP with zero hand-editing); full stdio/http/sse plus url+headers; a `/mcp` inspector; Settings MCP override.
- **Fix:** Make the MCP tab full CRUD: (1) extend `saveMcpServer` to accept `env` (`Record<string,string>`) plus a `type` field (`stdio`/`http`/`sse`) with url/headers, render a key=value env editor + a Show-tools expander per row; (2) add `deleteMcpServer` + `updateMcpServer` IPC + trash/edit controls, attributing source (user/project/plugin); (3) surface each server's start error + tool count to the renderer (new `mcpStatus` IPC or an AgentEvent) and show a red dot + error on failed rows; (4) switch args parsing to a quoted-aware tokenizer (or one-arg-per-line textarea) so paths/flags with spaces survive.
- **Effort:** L

---

### High

**H1. `describe()` case labels are stale — every built-in Flow/Fuzz tool call renders as an opaque raw-name chip** *(agent-loop, missed)*
- **What's wrong:** `Conversation.tsx:110-115` switches on the **dead** names `grasp_observe`/`grasp_diff`/`grasp_fuzz`, but the tools actually registered are `grasp_flow` (`tools.ts:336`), `grasp_flow_diff` (`tools.ts:371`), and `grasp_fuzz_diff` (`tools.ts:402`). The `tool_use` event carries the real name (`glm.ts:209` / `openai.ts:209`), so every Flow/Fuzz call falls through to the default branch (`Conversation.tsx:120`) → `{verb: 'grasp_flow', arg: ''}` (input has `trace`/`trace_file`, not `path`/`command`/`entrypoint`, so arg is empty). The chat chip for the product's entire reason to exist is an opaque raw token with no argument — worse than the MCP case, because this hits the primary surface on every turn.
- **Fix:** Add `grasp_flow`/`grasp_flow_diff`/`grasp_fuzz_diff` cases (verb `Observed`/`Diffed`/`Fuzzed`) and extract the entry from the submitted trace (`input.trace`/`input.trace_file` → parsed entry) for the arg. **One line per case** — the single highest-leverage fix in the conversation UX.
- **Effort:** S

**H2. Settings has no Commands tab and no Keybindings tab — two entire extension surfaces are filesystem-only and invisible** *(settings + discoverability + extensibility-mgmt + power-surface)*
- **What's wrong:** `Settings.tsx:18-24` `SECTIONS` is `keys/appearance/skills/mcp/plugins` only. `app/src/main/commands.ts` loads slash commands (project-over-user, skills-frontmatter unification — the ZCode idea, done well), `grasp:commands` IPC exists (`index.ts:72`), `App.tsx:165` loads them — but there is no Settings tab, no writer IPC, so a user must author `~/.grasp/commands/*.md` blind. `app/src/main/keybinds.ts` `loadKeybindings` is consumed at `App.tsx:100-102` but has zero Settings surface; the 5 default chords are never shown anywhere; `GraspApi.keybindings()` (`types.ts:272`) is **read-only** (no `setKeybindings`). Worse, the displayed hints are hardcoded literals that **drift on rebind**: CommandPalette items hardcode `hint:'⌘N'`,`'⌃`'`,`'⌘B'`,`'⌘L'` (`App.tsx:491,495-497`); `Sidebar.tsx:53,58` hardcodes `⌘N`/`⌘K`. If a user rebinds new-session to `mod+shift+n`, the sidebar still says `⌘N`. The one advantage over ZCode is wasted AND produces misleading UI.
- **Falls short of RE idea:** EXTENSIBILITY-RE §4.2 (Cmd+[/] back/forward, plain `[`/`]` prev/next-conversation, Cmd+F find), §5.5 (commands↔skills unification), §5.8 (extend with files AND surface them).
- **Fix:** Add two rail tabs. **Commands:** list each `/name` with description/source/skills-link, a New-command button writing a templated `.md` to `~/.grasp/commands`, an inline body editor. **Keybindings:** list each bindable action with its CURRENT resolved chord, a chord-capture input per row writing `~/.grasp/keybindings.json` via a new `setKeybindings` IPC, conflict detection, and an Open-`keybindings.json` fallback. Separately, drive the palette/sidebar `hint` strings from the same `keybinds` map instead of literals. Both reuse existing loaders — UI work, not new capability.
- **Effort:** M

**H3. No find-in-messages — sidebar Search just reopens the title-only palette, so past conversations are unfindable** *(discoverability + power-surface + agent-loop)*
- **What's wrong:** The sidebar Search button (`Sidebar.tsx:55-59`) calls `onSearch`, which in `App.tsx` is `() => setShowPalette(true)` — i.e. it opens the same Cmd+K palette whose Session group matches only session TITLES (`App.tsx:520-522`). Grep confirms no Cmd+F / find-in-messages handler. The only nav chords are the 5 in `DEFAULT_KEYBINDINGS`. With sessions capped at newest-100 (flat JSON) and no full-text search, a user literally cannot locate a past instruction or tool output. (See also the **session-rename** miss in M9 — auto-derived truncated titles compound this.)
- **Falls short of RE idea:** EXTENSIBILITY-RE §4.1 — a separate Cmd+F find mode that searches messages + file changes.
- **Fix:** Add a Cmd+F find bar scoped to the active transcript (the text is fully in `transcript` state — substring/regex over bubbles + tool-block text with next/prev and highlight, no new IPC). Add prev/next-conversation chords (`[`/`]`) wired to the sessions array. Restore the sidebar Search button to mean full-text search across sessions (grep the persisted transcript JSON returned by `sessions()`), not palette-reopen.
- **Effort:** M

**H4. Ask mode is all-or-nothing — a read-only `git log` prompts the same as `rm -rf`** *(agent-loop + extensibility-mgmt, refiled)*
- **What's wrong:** `MUTATING_TOOLS` (`app/src/main/backends/tools.ts:68`) is one flat set: `{write_file, edit_file, notebook_edit, run_bash, remote_bash}`, gated identically in Ask mode (`glm.ts:214`, `openai.ts:217`). No `readOnly` classifier, no safe-arg whitelist, no risk tier. (Note: MCP tools DO gate via `|| isMcpTool` at the same lines — the original "MCP bypasses approval" claim was a **verifier rejection**, factually wrong.) In Ask mode users either click Allow without reading or abandon Ask for Build (unsafe).
- **Falls short of RE idea:** ZAI-RE §1.3/§1.6 — per-tool 4-axis metadata (`riskLevel`/`sideEffectScope`/`needsApproval`/`readOnly`) + a Bash git-command danger classifier (whitelist of `git cat-file`/`git log`/`git grep` with safeFlags).
- **Fix:** Add a `readOnly` classifier allowing `read_file`/`list_dir`/`grasp_flow` unprompted and a safe-arg whitelist for `run_bash` (`git status/log/diff/cat-file/grep`, `ls`, `cat`) that bypasses the prompt; everything else in `MUTATING_TOOLS` still gates. Store a per-tool `riskLevel` on the `tool_use` event and surface it as a label on the ApprovalCard.
- **Effort:** M

**H5. Approval cards carry no risk context, no edit-before-run, and no allow-always** *(agent-loop)*
- **What's wrong:** `ApprovalCard` (`Conversation.tsx:217-243`) shows the bare tool name + raw command/path + "approval needed", Allow/Deny only. `requestApproval` (`app/src/main/approvals.ts:9-15`) emits only `{id, tool, input}` — no `riskLevel`, no consequence, no scope. No editable command field (you can't fix a typo before allowing), no "Allow always" / "Allow this session". A workflow running `npm test` five times prompts five times; a 200-char one-liner must be approved blind.
- **Fix:** Extend `approval_request` to carry `riskLevel` + a one-line consequence. On the card add: a risk badge (read-only/mutating/destructive), an editable command/path field pre-filled from input, and an "Allow once / Allow this session / Always allow this command" triple. Wire allow-always into an in-memory + persisted whitelist consulted before `requestApproval` is called.
- **Effort:** M

**H6. No keyboard stop (Esc) — the only way to halt a runaway agent is to mouse to the button** *(agent-loop)*
- **What's wrong:** `keybinds.ts` `DEFAULT_KEYBINDINGS` (5 actions, lines 11-17) has no stop entry; `App.tsx` actions map (`117-123`) has no stop entry. `stopAgent()` (`agent.ts:17`) is reachable only from the Send-button-swapped-to-stop icon (`Conversation.tsx:430-433`). The composer textarea is NOT disabled while busy (the original "composer is dead" claim was inaccurate — only `submit()` no-ops, `Conversation.tsx:287`), but there's still no escape hatch. **Critical implementation note:** the matcher at `App.tsx:109` requires `metaKey||ctrlKey`, so bare Escape won't fire even if bound — a fix must also relax that modifier gate.
- **Fix:** Add a `stop-agent` action bound to Escape (and Esc+Esc for safety) to the keybinds defaults + actions map: call `window.grasp.stopAgent()`. Gate on `busy`. Also accept Cmd/Ctrl+. as an alias.
- **Effort:** S

**H7. Workflow steps that error are silently marked `done` and the run advances — the durable runner is broken at the core** *(power-surface)*
- **What's wrong:** `WorkflowStep.status` has an `'error'` value (`shared/types.ts:211`) but it is **dead code**. `runWorkflow` (`App.tsx:213-241`) awaits `window.grasp.agent(...)` and, if not cancelled, **unconditionally** marks the step `'done'` and increments `currentStep` — no check on a turn outcome, no inspection of the `'error'` AgentEvent, no path to set `'error'`. (Root cause: `agent.ts:38` resolves `Promise<{messages}>` with no `ok` field, unlike the `observe`/`fuzz` IPC; on backend-unavailable it emits `'error'` AND returns `{messages: params.history}` at `agent.ts:45-47`.) The global error banner does flash (`App.tsx:427-431`) but `runWorkflow` never inspects it, then clears it on the next step (`setError(null)` at `App.tsx:212`). The retry affordance (`Workflow.tsx:100`) only fires when `status !== 'running' && !live`, so a quietly-"succeeded" step is never flagged for retry. `Workflow.tsx:78-79` renders only `done`/`paused` badges.
- **Falls short of RE idea:** EXTENSIBILITY-RE §4.4/§5.10 — `workflow_activity` status set `[queued|running|completed|failed|skipped|cancelled|cached|lost]` with `failure_json` per activity.
- **Fix:** After each agent turn, branch on outcome: capture an error flag from the `'error'` handler (or have `window.grasp.agent` resolve `{ok, error}` like `observe`/`fuzz` already do); on failure set step `'error'`, stop advancing, persist the workflow as `'paused'` (not `'done'`), surface the error in `WorkflowPanel` with the existing retry button enabled. Add a visible `'error'` badge.
- **Effort:** M

**H8. No workflow library — completed or dismissed workflows are unreachable forever** *(power-surface + discoverability)*
- **What's wrong:** The `workflows()` IPC returns ALL persisted workflows, but the UI surfaces only ONE: `App.tsx:184-190` finds the first interrupted (running/paused) workflow and binds it to `activeWf` as a banner. Once you click the banner's dismiss ✕ (`App.tsx:579`) the workflow vanishes from the UI entirely. Completed workflows cannot be browsed, re-run, inspected, or deleted — even though `deleteWorkflow` IPC exists. The "New workflow" button always starts from scratch — you cannot clone or re-run a prior workflow.
- **Fix:** Add a Workflows section to the sidebar (parallel to Sessions) listing `workflows()` with title, status dot, step count; click re-attaches as `activeWf` (resume if paused / replay if done). Hover actions: re-run (clone steps into a new run), delete. Mostly renderer wiring — the durable runner and IPC are already complete.
- **Effort:** S

**H9. No remote surface at all — SSH is an invisible one-shot agent tool and the terminal is local-only** *(power-surface + settings missed)*
- **What's wrong:** `app/src/main/ssh.ts` is hardened (BatchMode + StrictHostKeyChecking) but reachable ONLY as the agent's `remote_bash` tool (`tools.ts:314-334`) — one shell command at a time, zero UI: no host manager, no `~/.ssh/config` alias picker, no remote terminal pane, no "deploy the agent runtime" model. The Terminal pane (`terminal.ts:28-34`) spawns `pty.spawn` in the workspace cwd only. The user can only see a remote ran by spotting a `remote_bash` ToolBlock. Grep finds no SSH surface in the renderer.
- **Falls short of RE idea:** EXTENSIBILITY-RE §5.1 — "deploy the agent, not the command": ship the FULL runtime to `~/.zcode/server` and multiplex ~24 services over ONE SSH pipe so a remote box becomes a first-class instance.
- **Fix:** Two layers. (1) Near-term: add a host picker to the Terminal pane — read `~/.ssh/config` Host aliases, drive the existing `ssh` binary to open an interactive remote pty; add a "Remote hosts" section to Settings listing aliases with a connectivity probe. (2) Medium-term: surface `remote_bash` calls distinctly in the conversation (a "remote" chip + host label); explore deploying a grasp runner to the remote so remote agent turns work like local ones.
- **Effort:** L

**H10. Session fork is a hover-only, unlabeled glyph reachable only from the sidebar list** *(power-surface)*
- **What's wrong:** Fork — grasp's strongest session feature (preserves provenance via `parentId`) — is a 13px `⎇` button with `opacity:0` that only appears on sidebar hover (`index.css:545-546`), in `Sidebar.tsx:76-85`. Reachable ONLY from the sidebar list — never in-context (precisely when forking is most useful: "branch from HERE to try a risky change"). The glyph reads as "git branch", not "fork conversation". (Correction: a tooltip DOES exist at `Sidebar.tsx:78` `title="Fork — branch this session"`, but it's hidden behind the same hover wall.) No keyboard shortcut, no palette "fork current session" entry.
- **Fix:** Add a "Fork current session" affordance in the conversation header; add a "Fork session" item to the Cmd+K palette bound to the active `sessionId`; add `aria-label` and consider a `⌘Shift+F` chord through the existing rebindable system.
- **Effort:** S

**H11. No click-through from a tool result in the chat to the rendered Flow** *(agent-loop)*
- **What's wrong:** `ToolBlock`'s `tb-head` onClick only toggles `setOpen` (`Conversation.tsx:141`); there is no `onJumpToFlow` callback. The conversation and the instrument that justifies it are visually disconnected. (And per H1, the chip text is buggier than the original audit claimed — it's a raw `grasp_flow` token, not "Observed <entrypoint>".)
- **Fix:** Make `grasp_flow`/`grasp_flow_diff`/`grasp_fuzz_diff` tool chips clickable to switch the side pane to Flow (thread `onJumpToFlow` from Conversation into App calling `pickRight('flow')`). Tag each trace with the originating `tool_use` id so the run-switcher can correlate.
- **Effort:** M

**H12. Errors are one global banner with no classification, retry, or copy** *(agent-loop)*
- **What's wrong:** `error` is a single string state (`App.tsx:36`) rendered as `.msg-error` — bare mono text (`index.css:249`). No retry, no copy, no classification (a 429 looks identical to a 401 looks to a tool exception), no link to logs, not attached to the turn. The error `AgentEvent` carries only `{type:'error', error: string}` (`types.ts:177`). The previous turn's error lingers until `send()` clears it (`App.tsx:437`), so a stale red string sits under a fresh user message.
- **Fix:** Tag errors with a class (`auth`/`rate-limit`/`network`/`tool`/`model-unavailable`) at the backend: extend the error `AgentEvent` to carry `{error, class, retryable}` and render distinct copy + a Retry button when retryable. Attach the error to the turn as a failed-turn marker instead of a global banner; clear on next send. Add a copy icon.
- **Effort:** M

---

### Medium

**M1. No model/provider config tab; `agentMode`/`budget`/default-model are unpersisted** *(settings, corrected framing)*
- **What's wrong (corrected):** The "PROVIDERS drifted from BACKENDS because claude-code has no key row" framing was **rejected** — claude-code self-authenticates via the `claude` CLI / `~/.claude-zai` (`claude.ts:26-30`) and never calls `hasKey`/`getKey`/`setKey`, so `PROVIDERS=[glm,openai]` (`Settings.tsx:7-10`) is correct. The real gaps: `agentMode` (`App.tsx:65`) and `budget` (`App.tsx:142`) are plain `useState` with **no localStorage**, so they reset on restart; there is no default-backend/default-model setting; there is no provider-config UI (custom OpenAI-compatible endpoint, `GRASP_MODEL_BASE`).
- **Fix:** Add a Model-defaults section in Settings: default backend, default model, default agent mode, default budget, `flowAuto` default — all persisted to localStorage (mirror the existing theme/`flowAuto` pattern). Defer a full provider-catalog editor until a user actually needs a custom endpoint.
- **Effort:** M

**M2. Skills management is enable/disable only; the existing `Skill.warning` diagnostic is never rendered; no New-skill button** *(settings, corrected framing)*
- **What's wrong (corrected):** The "skills.ts drops a skill on description length" mechanism was **rejected** — skills.ts never drops: over `MAX_DESCRIPTION` (1024) sets a non-blocking `warning` (`skills.ts:58-59`), parse failures produce empty fields, "shadowed duplicate" is the documented project-over-user override (`skills.ts:89-97`). The genuine gap: `Settings.tsx:124-155` is a toggle-only list; the existing `warning` field is surfaced into the agent's `use_skill` listing (`tools.ts:457`) but **NOT into Settings**; there is no New-skill button despite the auto-seeded skill-creator (`skills.ts:249-276`); the empty-state "No skills found" (`Settings.tsx:133`) is misleading given 5 auto-seeded skills.
- **Fix:** Add a New-skill button that triggers the seeded skill-creator (or writes a minimal `SKILL.md` template to `~/.grasp/skills/<name>`). **Render the existing `Skill.warning` field** as a muted inline note per skill row so a mis-described skill is visible, not invisible.
- **Effort:** M

**M3. `saveMcpServer` swallows write failures; Add gives no feedback; plugin install is a 3s toast with no clone progress** *(settings)*
- **What's wrong:** `mcp.ts:52-56` wraps `writeFileSync` in `catch {}` returning void; if `~/.grasp/mcp.json` is unwritable, the Add button just clears fields and refreshes with no message (the server never appears, no explanation). `installPlugin` returns errors but the UI shows only a 3s toast (`Settings.tsx:252`) with the final `installed <name>` and no bundle detail; `plugins.ts:116` `spawnSync` has a 60s timeout and no streaming. A user who clicks Install and sees nothing for 30s reasonably assumes it hung.
- **Fix:** Have `saveMcpServer` return `ok/error` (installPlugin already does) and render the result inline under the form (reuse the `KeyRow` pattern). For installs, show a spinner with elapsed time and, on success, expand the new plugin row to list the skills + MCP servers it brought in.
- **Effort:** S

**M4. Plugins are uninstall-only: no enable/disable, no update, no marketplace, no per-plugin `userConfig` form, zero bundled** *(settings + extensibility-mgmt)*
- **What's wrong:** `Settings.tsx:200-261` offers install-from-git + user-only uninstall (`plugins.ts:139-148`). No `setEnabled` (disabling means deleting), no update (re-install blocked by `plugins.ts:115` "already exists" check), no restore, no marketplace. `Plugin` interface (`plugins.ts:15-22`) has no `userConfig` field → the typed `userConfig`→ENV bridge is **entirely absent**. `ensureDefaultSkills()` (`index.ts:69`) seeds SKILLS not plugins; grep finds no plugin seeding → the Plugin tab is an empty receptor on first run.
- **Falls short of RE idea:** EXTENSIBILITY-RE §2 / §5.4 / §5.6 — 6 bundled official plugins, demoted built-ins under the same contract, `setEnabled`, marketplace, restorable builtins, `userConfig`→ENV.
- **Fix:** (1) Add `setEnabled` IPC writing a `plugins-disabled.json` (mirror `skills-disabled.json`) + a toggle on every row; (2) make `installPlugin` overwrite on re-install (treat as update) or add an explicit `updatePlugin` doing `git pull`; (3) parse a `plugin.json` `userConfig` schema and render a typed form whose values write into the plugin MCP env on save; (4) seed 1-2 official plugins so the model is demonstrated.
- **Effort:** L

**M5. Token meter shows session-total only — no context-window usage, no budget proximity, no cost** *(agent-loop)*
- **What's wrong:** The meter shows `fmtTokens(props.tokens)` (`Conversation.tsx:340-354`), a running session sum accumulated at `App.tsx:421`. No per-turn figure, no context-window fraction, no warning before the hard stop (`glm.ts:174-176` / `openai.ts:173-175`). Budget input is bare numeric with placeholder "none". `usage` only fires at `message_delta` (`glm.ts:90-97`), so the meter is motionless during a long stream.
- **Fix:** Show this-turn tokens (reset on done) + session-total; render a thin context-window bar (turn tokens / model max-context) that fills as the stream accumulates. Add a soft warning at 80% of budget before the hard stop. Give the budget input a "tokens" suffix and 4k/16k/none presets.
- **Effort:** S

**M6. Tool blocks have no success/error affordance — a failed step looks like a success** *(agent-loop)*
- **What's wrong:** `TranscriptItem.status` is only `'running'|'done'` (`Conversation.tsx:20`); `tool_result` always sets `'done'` (`App.tsx:406`). Failed tools emit output starting `tool error: …` (`glm.ts:226`, `openai.ts:225`) and `run_bash` appends `[exit N]` (`tools.ts:310`) — the exit code is never parsed into an error flag. CSS has `.toolblock.open` and `.toolblock.running` only (`index.css:222-232`); no `.toolblock.error`. (Workflow steps DO have `.wf-step.error` at `index.css:559` — the pattern exists, just not for tool blocks.)
- **Fix:** Add `status:'error'` to `tool_result`, set when output matches a tool-error pattern or when `run_bash` exits non-zero. Render a `.toolblock.error` variant with a **thesis-disciplined** neutral marker (subdued border / `!` glyph in the question color — never red/green/✓/⚠), and prefix the chip verb so failed steps are scannable while collapsed.
- **Effort:** S

**M7. No message-level actions: copy, regenerate, edit-your-last-prompt** *(agent-loop)*
- **What's wrong:** User and assistant bubbles (`Conversation.tsx:312-326`) are static text with no hover affordances. No copy, no regenerate-resend-from-here, no edit-and-resend. Standard in Claude Code / ZCode; especially felt in a review surface where the user iterates on "is this what you expected."
- **Fix:** Add hover actions to assistant bubbles (copy, regenerate-resend-from-here) and to the last user bubble (edit-and-resend). Edit-last truncates `history.current` to that point and calls `send()` with the edited text.
- **Effort:** M

**M8. No mid-turn steering — you can type while busy but cannot send a course-correction** *(agent-loop, corrected)*
- **What's wrong (corrected):** The composer textarea is NOT disabled while busy (no `disabled` attribute, `Conversation.tsx:390-402`) — you CAN type; only `submit()` no-ops (`Conversation.tsx:287`) and `send()` guards on busy (`App.tsx:436`). No queue, no injection point in `glm.ts`/`openai.ts` `run()`. With `MAX_STEPS=40` the loop can run a long time with the user unable to nudge.
- **Fix:** Allow typing while busy and show the queued message as a "queued — sends after the current step" preview chip. At the top of each step iteration, check a steering queue; if non-empty, splice the message into the next user turn. Surface a small "steering…" indicator on the working dots.
- **Effort:** M

**M9. Sessions cannot be renamed — titles are auto-derived from the first user message and immutable** *(discoverability + power-surface, missed)*
- **What's wrong:** Every session's title is hardcoded to `(firstUser?.text ?? 'Session').slice(0, 44)` on each autosave (`App.tsx:285`). No rename affordance — not in the sidebar row (only Fork ✕ and Delete ✕, `Sidebar.tsx:76-95`), not in the conversation header, not in the palette, and no IPC for it (grep for `rename`/`setTitle` returns nothing user-facing). The autosave at `App.tsx:280-296` would also overwrite a user-set title. Combined with the 100-session cap (M11) and the flat title-only list (H3), a sessions-heavy user gets an undifferentiated wall of "fix the bug" / "fix the bug".
- **Fix:** Add an inline-rename on the sidebar row (double-click title or a rename action next to fork/delete) + a `grasp:renameSession` IPC writing the edited title into `SessionRecord.title`; have the autosave preserve a user-set title instead of overwriting it. Optionally a `pinned` flag.
- **Effort:** S

**M10. Right pane force-flips to Flow on every dataflow event, overriding the user's tab choice** *(power-surface)*
- **What's wrong:** `App.tsx:93-95` runs `useEffect(() => { if (surface) setRightTab('flow') }, [surface])` — every trace/diff/fuzz yanks the pane to Flow regardless of what the user is doing. If you're reading a file in Editor or previewing a dev server in Browser, the agent rips you to Flow mid-action. (Note: this is the same effect that fails to expand the collapsed pane per C2 — it both force-flips when open AND fails to open when collapsed.)
- **Fix:** Drop the unconditional `setRightTab('flow')`; auto-switch only on FIRST surface appearance of a session (or first surface while collapsed). Add a "pin current tab" toggle (or remember last manual pick within the session). A one-time toast "new dataflow — press F to view" is less invasive.
- **Effort:** S

**M11. Sessions and workflows are silently capped at 100 records — no warning, no pin, no archive** *(power-surface)*
- **What's wrong:** `sessions.ts:11,33` and `workflows.ts:10,32` both set `CAP = 100` and silently `slice(0, CAP)` the oldest records on every save. No UI indicating the cap is near, no pin/archive escape hatch — heavy users lose earliest sessions/workflows with no message and no recovery.
- **Falls short of RE idea:** EXTENSIBILITY-RE §4.3 — `pinned`/`archived`/`deleted` flags + a SQLite store so retention is explicit and reversible.
- **Fix:** Add `pinned` (and optionally `archived`) flags to `SessionRecord`/`WorkflowRecord`; never slice pinned records. When within 10 of cap, show a sidebar/Settings banner ("oldest sessions will be dropped — pin to keep"). For workflows specifically consider exempting non-errored, non-superseded definitions from the cap entirely.
- **Effort:** M

**M12. Switching sessions while busy is silently swallowed; the switch is also destructively state-replacing** *(power-surface)*
- **What's wrong:** `loadSession` (`App.tsx:308-312`) does `if (!rec || busy) return` — clicking a session mid-turn does nothing, zero feedback, sidebar rows not disabled. `applySession` (`App.tsx:298-307`) forcibly replaces workspace/backend/model from the loaded record — loading an old session silently switches your provider and project with no warning.
- **Fix:** Disable sidebar rows (and palette Session items) while busy with a "busy" affordance, OR queue the switch for when the turn settles. Before `applySession` replaces workspace/backend/model, if those differ from current, show a one-line confirmation ("this session used GLM/glm-4.6 in ~/other — switch?") with a "load transcript only" option. At minimum surface a toast on the ignored click.
- **Effort:** M

**M13. Browser is purely passive — no agent control loop and no navigation hardening** *(power-surface)*
- **What's wrong:** `Browser.tsx` is an Electron `<webview>` with a URL bar + back/forward/reload only. No `executeJavaScript`/element-picker the agent can drive, no `onOpenBrowserUrl` feedback so the agent learns what page loaded, and (a flagged PORT/ADAPT) no `will-attach-webview`/`will-navigate` hardening in main. The browser is a detached peek, not part of the observe-and-question surface.
- **Fix:** Wire a `grasp` tool that drives the active webview (navigate / eval-and-return-DOM / click-selector / read-console) and an `onOpenBrowserUrl` event back to the agent. In parallel, register `will-attach-webview` + `will-navigate` handlers in main to gate scheme/host. Until the agent loop is coupled, at least add the hardening.
- **Effort:** L

**M14. Session fork provenance is captured but never visualized — the list is flat and title-only** *(power-surface)*
- **What's wrong:** `SessionRecord.parentId` (`shared/types.ts:238`) is recorded on fork (`sessions.ts:49`) but rendered nowhere. `Sidebar.tsx:65-98` is a flat list of truncated titles — you can't tell a session was forked, can't navigate the fork tree, can't see per-branch backend/model/workspace. With more than ~8 sessions the list is an undifferentiated wall.
- **Falls short of RE idea:** EXTENSIBILITY-RE §4.3 — `session_task_link` provenance graph.
- **Fix:** Indent forked sessions under their parent with a connecting line and `⎇` marker on the child; show a relative timestamp and a workspace/model chip on each row. Optionally render a "forked from <title>" line in the conversation header when the active session has a `parentId`.
- **Effort:** M

**M15. Default keybindings lack prev/next-conversation, back/forward, and find chords** *(power-surface)*
- **What's wrong:** `App.tsx:117-123` wires only 5 actions (new-session, command-palette, toggle-terminal, toggle-sidebar, toggle-side-pane). No prev/next-conversation (ZCode plain `[`/`]`), no back/forward (`Cmd+[/]`), no find chord. (See also H2 for the missing editor/viewer.)
- **Fix:** Add `prev/next-conversation` and `toggle-find` to the default keybind map (plain `[`/`]` and `Cmd+F`). Surfaced in the new Keybindings tab from H2.
- **Effort:** M

**M16. SSH has ZERO Settings UI — the RE's #1 "great idea" is completely user-invisible** *(settings, missed)*
- **What's wrong:** `ssh.ts` is hardened remote exec over the system `ssh` binary, exposed ONLY as the agent's `remote_bash` tool (`tools.ts:314-334`). No Settings tab, no host manager, no `~/.ssh/config` alias picker, no remote-terminal pane, no "deploy the agent runtime" action — grep finds no SSH surface in the renderer.
- **Fix:** Add a Remote/SSH section to Settings: host list from `~/.ssh/config`, alias picker, status probe (`sshAvailable` + dry-run connect), eventual deploy-runtime. (Overlaps with H9 near-term.)
- **Effort:** L

**M17. Extension lists are loaded once on workspace switch and never refreshed** *(extensibility-mgmt, missed)*
- **What's wrong:** `App.tsx:162-169` loads `skills`/`commands`/`mcpServers`/`plugins` in a `useEffect` whose only dependency is `[workspace]`. Lists are never refetched when the user reopens Settings, and — critically — after the skill-creator agent writes a new `SKILL.md` (or a workflow installs one), the Skills tab stays stale until workspace switch or restart. This directly undermines the create→use loop.
- **Fix:** Refresh Skills/MCP/Plugins tabs on Settings open + an agent-event hook (e.g. after `write_file` under `~/.grasp`).
- **Effort:** S

**M18. Plugin rows show only `hasSkills`/`mcpCount` badges — no skill names, no MCP server names** *(extensibility-mgmt, missed)*
- **What's wrong:** `Settings.tsx:228` tags a plugin with a boolean `skills` chip and an `N mcp` number, but never lists the bundled skill names or MCP server names (already known at load: `plugins.ts` `mcpCount` from `readPluginMcpServers`, plugin skill roots from `pluginSkillRoots`). A user who installs a plugin cannot see what capabilities they gained. Plugin MCP servers namespace as `<plugin>__<server>` (`mcp.ts:78`) but the badge is non-clickable.
- **Fix:** Make the `N mcp` badge drill into the namespaced `<plugin>__<server>` entries; list bundled skill names. Closes the unit-of-distribution → unit-of-capability visibility gap.
- **Effort:** S

**M19. First-run onboarding is a one-shot key gate — after the key saves, no orientation** *(discoverability)*
- **What's wrong:** `KeyGate.tsx` fires only when no key is set (`App.tsx:482`). Single screen: brand, lede, three bullets, key input, footnote. Does not mention Cmd+K, the three side-pane tabs (Editor/Flow/Browser), Build/Ask/Plan modes, or that slash-commands and skills exist. After "Get started", no second step, no command-hint overlay — the user is dropped into an empty conversation.
- **Fix:** Make onboarding two-step: after the key saves, show a dismissible overlay (or enriched `conv-empty`) naming the three side tabs, the three modes, Cmd+K, and — once `/` lands — that typing `/` reveals skills/commands. Reuse the existing `conv-empty` block so it reappears on each new session until first send.
- **Effort:** M

**M20. Live MCP tools are uninspectable — the agent sees them, the user cannot** *(discoverability + extensibility-mgmt)*
- **What's wrong:** Settings MCP tab (`Settings.tsx:167-179`) lists server names + command strings, never the TOOLS. `backends/mcp.ts` calls `tools/list` and merges into the registry as `<server>__<tool>`, but that's shown nowhere — no `/mcp` command, no expand-to-tools. A user configures a server on faith, can't tell a broken/empty server from a working 23-tool one.
- **Fix:** Add a tools-count badge per MCP row + an expand listing tool names (data already cached in the registry; expose via a new `grasp:mcpTools` IPC). Optionally a `/mcp` slash-command (once `/` exists) that prints the same. Cheap, high-confidence win.
- **Effort:** S

**M21. Empty states for Skills/MCP/Plugins name the gap but don't guide; Commands has none** *(discoverability)*
- **What's wrong:** Skills (`Settings.tsx:133`) says only "No skills found in this project." — never mentioning that 5 are auto-seeded. MCP (`Settings.tsx:164`) "No MCP servers configured." with no example. Plugins (`Settings.tsx:207`) "No plugins installed." with no starter. The Flow empty state (`App.tsx:690-696`) IS guiding — these aren't.
- **Fix:** Rewrite each to point forward: Skills → "grasp seeds 5 example skills — enable them above; drop your own in `~/.grasp/skills`." MCP → a commented example (`npx -y @modelcontextprotocol/server-filesystem`) + "tools appear on the next turn." Plugins → a one-line starter + (once browse exists) a Browse button. Add the Commands tab (H2) so commands get their own guided empty state.
- **Effort:** S

**M22. No unified view of what extends the agent — Skills/MCP/Plugins/Commands are siloed** *(extensibility-mgmt)*
- **What's wrong:** Five Settings tabs treat each extensibility unit separately; nothing answers "what is extending my agent right now, and how many tools does that add?" Plugin MCP servers are namespaced `<plugin>__<server>` but the Plugins tab shows only a non-clickable "N mcp" badge.
- **Fix:** Either (a) add an "Extensions" overview tab at the top of the rail aggregating counts with deep-links, or (b) make the Plugins tab the home: each row expands to show bundled skills + MCP servers inline. At minimum make the plugin "N mcp" badge clickable to reveal namespaced server names (overlaps M18).
- **Effort:** M

**M23. MCP is stdio-only — no http/SSE/StreamableHTTP transport or auth-header servers** *(extensibility-mgmt)*
- **What's wrong:** `McpConnection.start()` always `spawn()`s a stdio child (`mcp.ts:103`). `McpServerConfig` (`mcp.ts:14-18`) has no `type`/`url`/`headers` fields. The Add form placeholder "command (e.g. npx)" (`Settings.tsx:182`) bakes the stdio assumption in. A remote/hosted MCP server cannot be connected from grasp at all.
- **Fix:** Extend `McpServerConfig` with `type: 'stdio'|'http'|'sse'` + optional `url`/`headers`. Add a transport selector to the Add form. Implement an http/sse client alongside stdio (the JSON-RPC layer is already transport-agnostic — only `onData`/`proc.stdin` change). (Folded into C3.)
- **Effort:** L

**M24. Subagent and plan-mode text does not stream — delegation looks frozen** *(agent-loop)*
- **What's wrong:** The GLM/OpenAI subagent loops call `callModel` with NO `onText` callback (`glm.ts:120`, `openai.ts:118`), so nested-task work shows working dots with zero live text until the whole sub-turn resolves. Plan mode withholds streaming by design (`glm.ts:161`) but its reasoning pops in as large non-streamed chunks (`glm.ts:197`). During a 30s delegation the conversation appears hung.
- **Fix:** Pass an `onText` to the subagent's `callModel` that emits `text_delta` with the parent tag (`subEmit` already tags events with `parentId`). For plan mode, optionally stream intermediate reasoning into a collapsible "thinking" block.
- **Effort:** S

**M25. `run_bash` approval is all-or-nothing — no per-command risk gradation** *(extensibility-mgmt, refiled from rejected Gap 9)*
- **What's wrong:** This is the valid residual of the rejected "MCP bypasses approval" gap. `MUTATING_TOOLS` (`tools.ts:68`) is one flat set gated identically, so a harmless read-only `git log` / `git cat-file` via `run_bash` prompts the same Allow/Deny as `rm -rf`. There is no `readOnly`/`riskLevel` metadata and no Bash git-subcommand danger classifier. Net effect is **manageability/UX noise in Ask mode (over-prompting)**, NOT a security hole.
- **Fix:** Classify safe read-only git subcommands (`git cat-file`, `git log`, `git grep` with safe flags) to run unprompted while `rm`/recursive paths still gate. (Same fix as H4.)
- **Effort:** M

---

### Low / Polish

**L1. The panebar "live" pulse dot labels stale data "live" on the default (flowAuto-off) setting — an active thesis lie** *(agent-loop, missed)*
- **What's wrong:** `App.tsx:607-612` renders the pulse + "live" whenever `surface` is truthy, with no check on `flowAuto` or edits-since-last-surface. `flowAuto` defaults to OFF (`App.tsx:41`), so the Flow on screen is frequently from several edits ago, yet the pill reads "live". The neutral question is only honest if the data is current — a "live" label on stale observed data invites the user to trust it. (This is the sharper defect behind the originally-filed "no staleness signal in the chat" gap.)
- **Fix:** Drive the pill off actual freshness — "live" only when `flowAuto` is on or the surface was just (re-)observed; otherwise "stale — last observed N edits ago" with a Run-flow action. Track edit-count-since-last-surface in App state.
- **Effort:** S

**L2. No reveal-config-folder affordance — users must hand-navigate hidden `~/.grasp` dirs** *(settings + extensibility-mgmt, missed)*
- **What's wrong:** Every Settings note points users at `~/.grasp/skills`, `~/.grasp/mcp.json`, `~/.grasp/plugins`, `~/.grasp/commands`, `~/.grasp/keybindings.json` — all hidden dirs (Settings.tsx:128-130,161,204). Grep finds **no `shell.openPath`/`shell.openExternal`** anywhere in `app/src`. Since MCP edit/delete, Commands, Keybindings, and plugin `userConfig` are all filesystem-only (see C3, H2, M4), the user is constantly sent to the filesystem with no shortcut.
- **Fix:** Add an "Open grasp folder" action (`shell.openPath` on `~/.grasp`) to the Settings header, plus per-tab "Reveal in file manager" buttons next to each path note. Trivial; large friction reduction.
- **Effort:** S

**L3. `flowAuto` default and on-demand toggle live only inside the Flow pane, not in Settings** *(settings)*
- **What's wrong:** `flowAuto` is a meaningful product behavior; its default is opinionated (off). The only control is a small auto-dot button buried in the Flow pane (`App.tsx:626-637`); no Settings reference. A user who collapses the side pane has no way to discover or change the default.
- **Fix:** Surface `flowAuto` as a checkbox under the new Behavior/Model-defaults section in Settings (alongside the persisted `agentMode`/`budget` from M1), keeping the in-pane dot as a quick toggle.
- **Effort:** S

**L4. No way to clear/remove a stored API key — `KeyRow` only replaces** *(settings, missed)*
- **What's wrong:** `vault.ts` exports `getKey`/`setKey`/`hasKey` but NO `removeKey`/`clearKey`. `Settings.tsx:27-73` `KeyRow` has only a replace flow; once set, you can overwrite but never wipe from the OS keychain via the UI. A user revoking must find and delete `grasp-key-*.bin` under Electron userData by hand.
- **Fix:** Add `removeKey` IPC + a Clear button on `KeyRow`.
- **Effort:** S

**L5. Composer gives zero discoverability cue — no hint that Cmd+K, `/`, or the modes exist** *(discoverability)*
- **What's wrong:** The only affordance in the composer (`Conversation.tsx:388-440`) is the placeholder "Ask an agent to change code…" and the mode toggle. No inline hint pointing to Cmd+K, no `/` cue, no "tip: type / for skills". The mode toggle's only doc is a `title=` tooltip.
- **Fix:** Add a one-line subdued hint under the textarea ("⌘K for commands · pick Build / Ask / Plan to control approval") and, once `/` ships, "/ for skills & commands". Trivial copy.
- **Effort:** S

**L6. MCP tool calls render as hostile raw-name chips** *(agent-loop)*
- **What's wrong:** `describe()` (`Conversation.tsx:120`) default branch returns `{verb: it.name, arg: path||cmd}`, so `android__tap` with no path/cmd renders as a raw-name chip. No friendly framing, no tool-description threading. (And per H1, the built-in Flow tools hit the same branch because of stale case labels — fixing H1 closes the built-in half.)
- **Fix:** For an unmapped tool, render `verb='Called'` and `arg` = the tool's human description (already on the Tool object — thread it through the `tool_use` event), namespace-display as "Plugin/Server · tool". Optionally a `/mcp` listing command.
- **Effort:** S

**L7. Skills have enable/disable but no in-app create/install path — the skill-creator loop doesn't close in the UI** *(extensibility-mgmt)*
- **What's wrong:** Skills tab (`Settings.tsx:124-155`) lists and toggles but offers no "New skill"/"Install skill" button. grasp seeds a skill-creator skill (`skills.ts:249-276`) but a user must know to invoke it via the palette or type the nudge. Installing someone else's skill means dropping files by hand. (Compounded by M17 — lists don't refresh after creation.)
- **Fix:** Add a "New skill" button that (a) creates a stub `~/.grasp/skills/<name>/SKILL.md` and opens it in the Editor, or (b) sends "Use the skill-creator skill" to bootstrap it. Optionally "Install skill from URL" mirroring plugin install.
- **Effort:** S

**L8. Terminal split panes share one workspace cwd; no rename, profile, or clear** *(power-surface)*
- **What's wrong:** The `+` split in `Terminal.tsx` (lines 24,40-41) adds side-by-side panes but every `TerminalPane` is spawned with the same workspace cwd (`Terminal.tsx:115` passes `workspace || '.'`) and labeled `term-0`/`term-1`/…. No per-terminal cwd chooser, no clear/reset, no shell-profile selection, no title.
- **Fix:** Give each split an inline-renameable title + a small cwd field (defaulting to workspace). Add a "clear" action (`xterm .clear()` + fresh prompt).
- **Effort:** S

**L9. Model/provider catalog has no UI** *(discoverability, missed — borderline-adjacent)*
- **What's wrong:** `Settings.tsx` `PROVIDERS` (lines 7-10) is a hardcoded 2-element list (glm + openai). No UI to register a custom OpenAI-compatible endpoint, change `GRASP_MODEL_BASE`, or set a non-default model id — all requires editing files or env. Model SELECTION is fine (`ModelPicker` in the composer foot); model/provider DISCOVERY/configuration is not surfaced. (Borderline — config more than navigation; overlaps M1.)
- **Fix:** Fold into the M1 Model-defaults section: a "custom OpenAI-compatible endpoint" form writing `GRASP_MODEL_BASE`/`GRASP_MODEL` to a persisted config. Defer a full catalog until needed.
- **Effort:** M

---

## 3. Gaps by area

### Settings + config UX (`app/src/renderer/src/components/Settings.tsx`, `app/src/main/index.ts`)

| Gap | Severity | Fix (one-line) | Effort |
|---|---|---|---|
| MCP nearly unmanageable — drops env, mangles args, no edit/delete/health/tools | Critical (C3) | Full CRUD + env editor + transport type + health/tools IPC | L |
| No Commands tab and no Keybindings tab | High (H2) | Two rail tabs (list + create/edit + chord capture) | M |
| Plugins uninstall-only — no enable/disable/update/marketplace/userConfig/bundled | Medium (M4) | `setEnabled` + update + userConfig form + seed official | L |
| No model/provider config tab; `agentMode`/`budget`/defaults unpersisted | Medium (M1) | Model-defaults section persisted to localStorage | M |
| Skills enable/disable only; `Skill.warning` never rendered; no New-skill | Medium (M2) | Render existing `warning`; New-skill button | M |
| `saveMcpServer` swallows writes; install is a 3s toast with no progress | Medium (M3) | Return ok/error inline; spinner + bundle detail | S |
| SSH has zero Settings UI | Medium (M16) | Remote/SSH section: host list + alias picker + probe | L |
| No reveal-config-folder affordance | Low (L2) | `shell.openPath(~/.grasp)` + per-tab Reveal buttons | S |
| `flowAuto` toggle lives only inside the Flow pane | Low (L3) | Surface under Behavior/Model-defaults | S |
| No way to clear a stored API key | Low (L4) | `removeKey` IPC + Clear button on KeyRow | S |

### Discoverability + navigation + onboarding (`CommandPalette.tsx`, `keybinds.ts`, `Sidebar.tsx`, `KeyGate.tsx`)

| Gap | Severity | Fix (one-line) | Effort |
|---|---|---|---|
| No `/` slash menu in composer; palette strips `$ARGUMENTS`/`$N` | Critical (C1) | Inline composer slash-menu with arg prompting | M |
| No Commands tab (slash-commands filesystem-only, unlisted) | High (H2) | Settings Commands tab | M |
| Keybindings invisible; hardcoded hints drift on rebind | High (H2) | Settings Keybindings tab + drive hints from keybinds map | M |
| No find-in-messages; Search reopens title-only palette | High (H3) | Cmd+F find bar + cross-session grep | M |
| MCP/Plugin/SSH buried and incomplete | High (C3, M4, H9) | (See those) | L |
| No workflow library | High (H8) | Sidebar Workflows section | S |
| Sessions can't be renamed; titles auto-derived, immutable | Medium (M9) | Inline rename + `renameSession` IPC | S |
| First-run onboarding is a one-shot key gate | Medium (M19) | Two-step orientation overlay | M |
| Live MCP tools uninspectable | Medium (M20) | Tools-count badge + expand + `/mcp` | S |
| Empty states name the gap but don't guide | Medium (M21) | Rewrite each to point forward | S |
| Composer zero discoverability cue | Low (L5) | One-line hint under textarea | S |
| Model/provider catalog has no UI (adjacent) | Low (L9) | Fold into Model-defaults | M |

### Agent-loop conversation UX (`Conversation.tsx`, `agent.ts`, `glm.ts`/`openai.ts`, `approvals.ts`)

| Gap | Severity | Fix (one-line) | Effort |
|---|---|---|---|
| Collapsed side pane silently swallows the Flow | Critical (C2) | `expand()` on surface arrival + badge/toast | S |
| `describe()` stale case labels → Flow chips are raw tokens | High (H1) | Add `grasp_flow*` cases; one line each | S |
| Ask mode all-or-nothing (read-only git gates like rm -rf) | High (H4) | readOnly classifier + safe-git whitelist | M |
| Approval cards carry no risk context/edit/allow-always | High (H5) | Risk badge + editable field + allow-always triple | M |
| No keyboard stop (Esc) | High (H6) | `stop-agent` action; relax meta/ctrl gate | S |
| No click-through from tool chip → Flow pane | High (H11) | `onJumpToFlow` callback + tool_use id tagging | M |
| Errors: one global banner, no class/retry/copy | High (H12) | Tagged `{class, retryable}` + per-turn + Retry | M |
| Token meter session-total only | Medium (M5) | Per-turn + context-window bar + budget presets | S |
| Tool blocks no success/error affordance | Medium (M6) | `status:'error'` + thesis-disciplined `.toolblock.error` | S |
| No message-level actions (copy/regenerate/edit-last) | Medium (M7) | Hover actions on bubbles | M |
| No mid-turn steering | Medium (M8) | Queue chip + step-boundary injection | M |
| Subagent/plan-mode text doesn't stream | Medium (M24) | Pass `onText` to subagent `callModel` | S |
| Panebar "live" pill lies on default setting | Low (L1) | Drive off freshness, not `surface` truthiness | S |
| MCP tool calls render as hostile raw-name chips | Low (L6) | `verb:'Called'` + tool description threading | S |

### Sessions / workflows / terminal / browser UX (`sessions.ts`, `workflows.ts`, `Workflow.tsx`, `Terminal.tsx`, `Browser.tsx`, `ssh.ts`)

| Gap | Severity | Fix (one-line) | Effort |
|---|---|---|---|
| Workflow steps that error silently marked done | High (H7) | Branch on turn outcome; `agent()`→`{ok,error}`; `'error'` badge | M |
| No workflow library | High (H8) | Sidebar Workflows section | S |
| No remote surface (SSH invisible, terminal local-only) | High (H9) | Host picker + remote pty + Settings Remote section | L |
| Session fork hover-only unlabeled glyph | High (H10) | Header Fork affordance + palette entry + chord | S |
| Right pane force-flips to Flow on every dataflow | Medium (M10) | Only auto-switch on first surface; "pin tab" toggle | S |
| Browser purely passive; no hardening | Medium (M13) | Agent webview tool + `will-attach-webview`/`will-navigate` | L |
| Fork provenance captured, never visualized | Medium (M14) | Indent children; timestamp + workspace/model chip | M |
| Switching sessions while busy silently swallowed + destructive | Medium (M12) | Disable rows / queue switch; confirm backend switch | M |
| 100-record silent cap; no pin/archive | Medium (M11) | `pinned`/`archived` flags + near-cap banner | M |
| Default keybindings lack prev/next + back/forward + find | Medium (M15) | Add `[`/`]`, `Cmd+[/]`, `Cmd+F` defaults | M |
| Sessions can't be renamed | Medium (M9) | Inline rename + `renameSession` IPC | S |
| Terminal split panes share cwd; no rename/clear | Low (L8) | Per-pane title + cwd field + clear action | S |

### Skills / Plugins / MCP / Commands management UX (`skills.ts`, `plugins.ts`, `mcp.ts`, `commands.ts`, `keybinds.ts`)

| Gap | Severity | Fix (one-line) | Effort |
|---|---|---|---|
| No `/` slash menu (commands/skills hidden; palette strips args) | Critical (C1) | Inline composer slash-menu with arg prompting | M |
| MCP uneditable/undeletable; drops env; stdio-only; health invisible | Critical (C3) + Medium (M23) | Full CRUD + env + transport + health/tools IPC | L |
| Commands have no management UI (not even listed) | High (H2) | Settings Commands tab | S |
| Plugins install + uninstall only; zero bundled | High (M4) | `setEnabled` + update + userConfig + seed | L |
| Keybindings loaded/rebindable but no editor | High (H2) | Settings Keybindings tab + `setKeybindings` IPC | M |
| MCP server health + tool-count invisible | Medium (M20) | Status dot + tool count + `mcpStatus` IPC | M |
| No unified extensions view | Medium (M22) | Overview tab or expandable plugin rows | M |
| Extension lists never refresh after creation | Medium (M17) | Refresh on Settings open + write_file hook | S |
| Plugin rows hide bundled skill/MCP names | Medium (M18) | Drill-in badge + skill/MCP name listing | S |
| `run_bash` approval all-or-nothing | Medium (M25) | Safe-git whitelist | M |
| Skills no in-app create/install path | Low (L7) | New-skill button → stub or skill-creator | S |

---

## 4. What grasp gets RIGHT (do not break)

- **Credentials over plaintext.** Per-provider keys in Electron `safeStorage` (OS keychain), never plaintext, never shipped (`app/src/main/vault.ts`). ZCode used plaintext/`enc:v1`. The one residual: no UI to *clear* a key (L4).
- **SSH host-key security.** `ssh.ts` runs the system `ssh` binary with BatchMode (key/agent only, no password) + `StrictHostKeyChecking=yes` — unknown/changed hosts are REFUSED. This is a deliberate fix for ZCode's accept-any MITM flaw.
- **File-driven REBINDABLE keybindings.** `~/.grasp/keybindings.json` merged over defaults (`keybinds.ts`). ZCode's chords are hardcoded. grasp is ahead here — the gap is only that the capability is invisible (H2).
- **The two hardest ZCode ideas are already implemented.** (a) Skills as a three-layer progressive-disclosure onion with the **base-directory annotation** as the linchpin (`skills.ts`) — metadata in context under 8KB, body on `use_skill`, references on `read_file`. (b) **Commands↔skills unification** via the `skills:` frontmatter key — a deterministic user-typed alias for a model-decidable skill (`commands.ts`). The gap is purely the missing `/` entry ramp (C1) and the missing Settings tabs (H2).
- **The agent loop is owned and honest.** Real tool-use loop (GLM via Anthropic Messages wire), streaming text wired, Ask/Build/Plan modes, pre/post-turn git checkpoints, a real toolset (`read_file`/`write_file`/`edit_file`/`run_bash`/`remote_bash`/`grasp_flow*`/`use_skill`/`TodoWrite`/`task` + MCP). MCP tools DO gate in Ask mode (the `|| isMcpTool` clause).
- **The moat is enforced.** `Operand(provenance="guessed")` raises; output ends in a neutral question, never a verdict; no phantom change; unexercised paths are visibly ghosted. The visual discipline must be preserved when adding error affordances (M6) — neutral markers in the question color, never red/green/✓/⚠.
- **MCP start-failures are honest.** `McpRegistry.start()` returns per-server errors and never fakes a dead server — the defect is only that those errors never reach the renderer (C3).
- **MCP provenance is captured where it matters.** Namespaced `<server>__<tool>` / `<plugin>__<server>` routing; lazy per-workspace cache; `clearMcpCache` on config change.
- **The engine seam is sound.** `app/src/main/engine.ts` shells the Python skill; the shared `GraphModel`/`GraphDiffModel` contract mirrors `engine/dreplay/flow_graph.py`. Both the surface and the organ exist.

---

## 5. Recommended fix order

Effort in brackets. Lead with quick high-impact UX wins (nav, discoverability, empty states, the one-line Flow-chip fix), then the bigger feature work. Each step is independently shippable.

1. **[S] H1 — Fix the `describe()` stale case labels.** One line per case (`grasp_flow`/`grasp_flow_diff`/`grasp_fuzz_diff`). Makes the moat legible in the chat on every turn. Cheapest, highest-leverage patch in the report.
2. **[S] C2 — Stop the collapsed side pane from swallowing the Flow.** `expand()` on surface arrival + a badge/toast. The product thesis literally disappears without this.
3. **[S] H6 — Esc to stop the agent** (and relax the `metaKey||ctrlKey` gate at `App.tsx:109`). Standard escape hatch.
4. **[S] L2 — Reveal-in-file-manager** affordances. Trivial, large friction reduction; unblocks every filesystem-only gap.
5. **[S] M21 — Rewrite the Skills/MCP/Plugins empty states** to point forward (auto-seeded skills, example MCP line, starter plugin).
6. **[S] L5 — Composer discoverability hint.** One line of copy under the textarea.
7. **[S] H8 — Sidebar Workflows section.** Renderer wiring over the existing durable runner + `deleteWorkflow` IPC. Completes the workflow feature.
8. **[S] H10 — In-context Fork affordance + palette entry.** Surfaces grasp's strongest session feature.
9. **[S] M9 — Session rename.** Inline + `renameSession` IPC; preserve user titles on autosave.
10. **[M] C1 — `/` slash menu in the composer with argument prompting.** Restores the primary discoverability ramp AND fixes parameterized commands. **The single biggest UX win in the report.**
11. **[M] H2 — Settings Commands + Keybindings tabs** (and drive palette/sidebar hints from the keybinds map).
12. **[M] H3 — Cmd+F find-in-messages + prev/next-conversation chords** (`[`/`]`).
13. **[S/M] H4+M25 — Split `MUTATING_TOOLS`**: readOnly classifier + safe-git whitelist so read-only git runs unprompted.
14. **[M] H5 — Approval-card risk context + edit-before-run + allow-always.**
15. **[M] H7 — Workflow error capture** (`agent()` → `{ok,error}`; `status:'error'`; pause-not-done; retry). Fixes the durable runner.
16. **[M] H11 — Click-through from Flow tool chips to the Flow pane** (paired with H1).
17. **[M] H12 — Error classification + Retry + per-turn attachment.**
18. **[L] C3 — MCP full CRUD + env + transport type + health/tools IPC + quoted-aware arg tokenizer.** The largest single fix; unblocks the headline extensibility surface.
19. **[S] M3 — `saveMcpServer` returns ok/error; install spinner + bundle detail.**
20. **[M] M20 — MCP tools-count badge + expand + `/mcp` listing.**
21. **[L] M4 — Plugins `setEnabled` + update + userConfig form + seed 1-2 official.**
22. **[M] M2 — Skills New-skill button + render existing `Skill.warning`.**
23. **[M] M1 + L3 — Model-defaults section in Settings** (persist `agentMode`/`budget`/default-model/`flowAuto`).
24. **[S] M17 — Refresh extension lists on Settings open + `write_file` hook.**
25. **[S] M18 — Plugin drill-in (skill/MCP names).**
26. **[M] M10 — Drop unconditional `setRightTab('flow')`; "pin tab" toggle.**
27. **[S] L1 — Drive the "live" pill off freshness, not `surface` truthiness** (thesis-integrity).
28. **[M] M6 — Tool-block error affordance** (thesis-disciplined neutral marker).
29. **[S] M5 — Token meter: per-turn + context-window bar + budget presets.**
30. **[S] M24 — Stream subagent/plan-mode text.**
31. **[M] M7 — Message-level actions (copy/regenerate/edit-last).**
32. **[M] M8 — Mid-turn steering queue.**
33. **[M] M12 — Busy-silent + destructive `applySession` confirmation.**
34. **[M] M11 — `pinned`/`archived` flags + near-cap banner.**
35. **[M] M14 — Visualize fork provenance + workspace/model chips.**
36. **[M] M15 + M22 — Default nav chords + unified Extensions overview.**
37. **[M] M19 — Two-step onboarding overlay.**
38. **[L] H9 + M16 — Remote/SSH UI** (host picker + remote pty + Settings Remote section). Large; aspire to deploy-runtime later.
39. **[L] M13 — Browser agent control loop + `will-attach-webview`/`will-navigate` hardening.**
40. **[S] L4/L6/L7/L8 + M18/L9** — Polish tail (key clear, MCP-chip framing, skill create button, terminal splits, model catalog).

**Themes to preserve through every fix:** the moat (observed-not-guessed, facts-not-verdicts, no phantom change, visual discipline — no red/green/✓/⚠), credentials in `safeStorage`, SSH `StrictHostKeyChecking`, file-driven rebindable keybindings, and the skills/commands progressive-disclosure onion. The product is capable; the work is making it *legible*.