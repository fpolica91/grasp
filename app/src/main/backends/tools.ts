// The shared tool registry for grasp's OWN tool-use loops (GLM, OpenAI). File and
// shell tools are workspace-scoped; the grasp_* tools are the instrument itself —
// they run code FOR REAL and surface observed dataflow into the UI. Claude Code
// brings its own tools, so it does not use this registry (but shares liveSurface).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { validateTrace, validateObservation, diffTraces, buildFuzzDiff, validateClaim, validateAxes, type TraceDoc, type FuzzCase, type FuzzClaim, type FuzzAxes } from '../../shared/trace'
import { listSkills, readSkill, skillsListing } from '../skills'
import { requestElicitation } from '../approvals'
import type { Emit } from './types'
import type { IntroDoc } from '../../shared/types'
import { McpRegistry } from './mcp'
import { sshExec } from '../ssh'
import { remoteStatus, remoteExec, remoteReadFile, remoteWriteFile } from '../remote'
import { parse as parseYaml } from 'yaml'
import { validateModel, checkModel, type BehaviorModel, type CaseRun } from '../../shared/model'

// When a remote SSH session is active, the agent's file/shell tools route over it —
// so the agent RUNS ON THE REMOTE. joinR keeps paths under the remote workspace.
const joinR = (ws: string, rel: string): string =>
  (`${ws.replace(/\/$/, '')}/${(rel || '').replace(/^\/+/, '')}`).replace(/\/+$/, '') || ws
const remoteWs = (): string => (remoteStatus().cwd ?? '')

// A workspace may be a CONTAINER of repos; repos own their files (.grasp/ — model,
// recipe, scratch). grasp resolves the OWNING repo by walking up from the anchor (the
// file it was handed) to the nearest git root, never above the workspace. No anchor and
// no git at the workspace = a container: nothing is read or written there, ever.
function resolveRepoRoot(workspace: string, anchor?: string): { home: string; container: boolean } {
  const ws = resolve(workspace || '.')
  let dir = anchor ? dirname(resolve(anchor)) : ws
  if (!dir.startsWith(ws)) dir = ws
  for (;;) {
    if (existsSync(join(dir, '.git'))) return { home: dir, container: false }
    if (dir === ws) break
    const parent = dirname(dir)
    if (!parent.startsWith(ws) || parent === dir) break
    dir = parent
  }
  return { home: ws, container: !existsSync(join(ws, '.git')) }
}

// Load the workspace behavior model (spec-v2 §1.1). Returns the model, a note (invalid
// model — surfaced, never silently ignored), or nothing (no model file: pre-v2 workspace).
function loadModel(workspace: string, anchor?: string): { model?: BehaviorModel; note?: string; home: string } {
  const { home, container } = resolveRepoRoot(workspace, anchor)
  if (container)
    return { home, note: 'this workspace is a CONTAINER of repos (no git root here) — models live per-repo at each repo root; run against files inside a repo.' }
  const p = join(home, '.grasp', 'model.yaml')
  if (!existsSync(p)) return { home }
  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(p, 'utf-8'))
  } catch (e) {
    return { home, note: `model.yaml is not valid YAML: ${e instanceof Error ? e.message : String(e)} — rules were NOT checked.` }
  }
  const err = validateModel(parsed)
  if (err) return { home, note: `model.yaml rejected: ${err} — rules were NOT checked.` }
  return { home, model: parsed as BehaviorModel }
}

function resolvePath(workspace: string, p: string): string {
  return p.startsWith('/') ? p : join(workspace || '.', p)
}


const OUT_CAP = 8000

// The agent's shell must see the USER'S environment, not grasp's own launch chain. An Electron
// app started via `npm run dev` carries npm_config_* / npm_lifecycle_* / NODE_ENV / NODE_OPTIONS
// into every child process, silently changing how npm/node behave inside the workspace
// (observed: an inherited omit=dev made a repo's devDependencies uninstallable and cost a turn
// its step budget). The compiler must be invisible to the target: strip the debris, keep the
// user's real environment (PATH, HOME, shell config via bash -l).
const ENV_DEBRIS = /^(npm_|NODE_ENV$|NODE_OPTIONS$|INIT_CWD$|ELECTRON_|VITE_|ORIGINAL_XDG_)/i
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!ENV_DEBRIS.test(k)) env[k] = v
  return env
}

export const SYSTEM = [
  'You are grasp, a coding agent inside the post-editor. You edit code with the file and',
  'shell tools. But you do NOT assert a change "works", is "fixed", or is "safe".',
  '',
  "grasp's whole reason to exist is the OBSERVED DATAFLOW rail: it runs the code FOR REAL",
  'and shows the human the values it bound and the paths it took. That rail is populated',
  'by grasp_flow / grasp_flow_diff — and ONLY by them. This is non-negotiable:',
  '',
  '• To verify ANY code you write or change, you MUST use grasp_flow (submit the observed Flow) or',
  '  grasp_flow_diff (edited existing code — the A→B change) on the entrypoint. For an edit to EXISTING',
  '  logic, prefer grasp_fuzz_diff — it varies the input space and surfaces any input where old vs new',
  '  diverge, so a bug that only breaks inputs you did not try is not missed. This is your PRIMARY way to show a',
  '  change did what you intended — do it proactively, not only when asked. When a sweep diverges,',
  '  CHARACTERIZE it: resubmit the cases_file as {cases, claim: {where, effect}, axes} — grasp checks',
  '  the claim against every observed case and renders the checked contract delta (consistent /',
  '  mismatched / untested / enumeration). Generate cases STRADDLING your boundary to falsify your',
  '  own claim before submitting; an unchecked claim is never rendered.',
  '• NEVER verify by writing an ad-hoc test script and running it through run_bash (a one-off',
  "  inline script, a throwaway harness file). That runs the code but leaves grasp's",
  '  dataflow rail BLIND — the human sees nothing. An ad-hoc harness is a failure, not a shortcut.',
  '• They work across languages. Entrypoint form: a file path plus symbol (path/to/file.ext:symbol)',
  '  or module.symbol. grasp auto-detects the language from repo files; when a repo has no clear',
  '  marker, pass the `language` argument explicitly.',
  '• The default Flow for an APPLICATION repo comes from the RUNNING APP: start it the way the',
  '  human would (its own dev command), drive the REAL feature surface (route, URL, endpoint,',
  '  CLI) with a REAL input (README example, fixture, recorded payload), attach via the native',
  '  runtime channel. A test-runner probe is a FALLBACK for logic with no runnable surface and',
  '  must be declared as such in the `how` field. Never silently fabricate an input when a real',
  '  one exists.',
  '• If the logic is UI/DOM-coupled, observe it IN the running app first. Extract it into a',
  '  plain callable module only when the app cannot be driven or the question needs input',
  '  variation (fuzz) — and extraction is a REFACTOR, not a copy: rewire the call site so the',
  '  observed code IS the shipped code. Do not shrug and reach for run_bash: run, attach, observe.',
  '• run_bash is for genuinely non-observable steps only: installing deps, starting a server,',
  '  a build. When you use it to RUN logic because you think there is no entrypoint, stop and',
  '  extract an entrypoint first.',
  '• If .grasp/model.yaml exists, it is the human\'s standing judgment: generate edits TOWARD it,',
  '  label every fuzz case with scenario names its rules quantify over, and if a request contradicts',
  '  a ratified rule, surface the contradiction BEFORE editing (behavior-model skill). When the human',
  '  answers "intended" to novel behavior, stage the ratification — never enforce your own judgment.',
  '• On a workspace you have not observed before, load the load-repo skill FIRST: read .grasp/RECIPE.md',
  '  if present — it is cached knowledge of how this repo runs; trust it per rung, verify with one cheap',
  '  probe — and pay observability lazily: climb only the rung the task demands (runnable → traceable →',
  '  diffable → fuzzable → characterizable), then record what you learned back into the recipe.',
  '',
  '• Prefer edit_file over write_file for changes to existing files — it rewrites only the',
  '  snippet you specify, so it is safer; use write_file to create a file or replace it entirely.',
  '  Use TodoWrite to plan any task with three or more steps. Batch INDEPENDENT tool calls into',
  '  ONE turn (multiple tool_use blocks): read several files at once, run unrelated commands',
  '  together. One call per turn wastes a full model round-trip each time.',
  '',
  'Present exactly what grasp_flow/grasp_flow_diff surface and end in the neutral question they',
  'give you; the human adjudicates against business rules only they know. Never render a verdict.'
].join(' ')

// PLAN MODE: inspect-only. The agent may read and observe, never mutate; its final
// message is the proposed plan, which grasp holds for human approval before execution.
export const PLAN_TOOL_NAMES = new Set(['read_file', 'list_dir', 'grasp_flow', 'ask_user'])
export const PLAN_SYSTEM =
  SYSTEM +
  ' PLAN MODE IS ACTIVE: you may only inspect (read_file, list_dir, grasp_flow). You cannot' +
  ' edit files or run commands. Investigate, then end with a concrete step-by-step plan of the' +
  ' exact changes you propose (files, edits, and how the change should be observed). The human' +
  ' will approve the plan before anything is executed.'

// ASK MODE: these tools change the workspace, so they pause for human approval. They are also
// the set that triggers liveSurface (a code change should re-run the observed dataflow).
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit', 'run_bash', 'remote_bash', 'ApplyPatch'])
// The fuzz reminder fires only on ACTUAL file edits — run_bash may mutate, but treating every
// shell command (grep, ls, npm install) as "you changed code" spams false reminders (observed).
export const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit', 'ApplyPatch'])

// A subagent runner: run a focused sub-task and return its final text. Events it emits
// are tagged with the parent task's id so the UI nests them.
export interface SubagentOpts { system?: string; tools?: Tool[] }
export type SubagentRunner = (prompt: string, parentId: string, opts?: SubagentOpts) => Promise<string>

export interface ToolCtx {
  workspace: string
  emit: Emit
  toolId?: string // the current tool_use id (parent for a task's subagent)
  subagent?: SubagentRunner // present when the backend supports delegation
}

export interface Tool {
  name: string
  description: string
  input_schema: object
  run(input: Record<string, unknown>, ctx: ToolCtx): Promise<string>
}

function inside(workspace: string, p: string): string {
  const abs = resolve(workspace, String(p ?? '.'))
  if (!abs.startsWith(resolve(workspace))) throw new Error('path escapes the workspace')
  return abs
}
const cap = (s: string): string => (s.length > OUT_CAP ? s.slice(0, OUT_CAP) + `\n…(+${s.length - OUT_CAP} chars)` : s)

// Per-workspace objective tracker (the `goal` tool — GoalRead-equivalent).
const goals = new Map<string, string>()

// ApplyPatch: apply a Claude-Code-style patch (Add/Delete/Update File with ' '/'-'/'+' hunks).
function applyHunk(orig: string, hunk: string[]): { ok: boolean; text?: string; error?: string } {
  const search: string[] = []
  const replace: string[] = []
  for (const raw of hunk) {
    if (raw.startsWith('@@') || raw === '') continue
    const c = raw[0]
    const rest = raw.slice(1)
    if (c === '+') replace.push(rest)
    else if (c === '-') search.push(rest)
    else if (c === ' ') { search.push(rest); replace.push(rest) }
    else { search.push(raw); replace.push(raw) } // no prefix → context
  }
  const sStr = search.join('\n')
  const rStr = replace.join('\n')
  if (!sStr) return { ok: false, error: 'no anchor (context/removed lines) in hunk' }
  const count = orig.split(sStr).length - 1
  if (count === 0) return { ok: false, error: 'anchor not found — re-read the file, your view is stale' }
  if (count > 1) return { ok: false, error: `anchor matches ${count} places — add more context` }
  return { ok: true, text: orig.replace(sStr, rStr) }
}
export function applyPatch(workspace: string, patch: string): string {
  const lines = patch.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].includes('*** Begin Patch')) i++
  i++
  const reports: string[] = []
  while (i < lines.length) {
    const line = lines[i]
    if (line.includes('*** End Patch')) break
    if (line.startsWith('*** Add File: ')) {
      const rel = line.slice(14).trim()
      const content: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('*** '); i++) content.push(lines[i])
      const p = inside(workspace, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content.join('\n'), 'utf-8')
      reports.push(`added ${rel}`)
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      const rel = line.slice(17).trim()
      const p = inside(workspace, rel)
      if (existsSync(p)) { try { unlinkSync(p) } catch { /* ignore */ } reports.push(`deleted ${rel}`) }
      i++
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      const rel = line.slice(17).trim()
      const p = inside(workspace, rel)
      i++
      if (!existsSync(p)) { reports.push(`skipped ${rel}: file not found`); continue }
      const hunk: string[] = []
      for (; i < lines.length && !lines[i].startsWith('*** '); i++) hunk.push(lines[i])
      const r = applyHunk(readFileSync(p, 'utf-8'), hunk)
      if (!r.ok) { reports.push(`failed ${rel}: ${r.error}`); continue }
      writeFileSync(p, r.text!, 'utf-8')
      reports.push(`updated ${rel}`)
      continue
    }
    i++
  }
  return reports.length ? 'patch applied:\n' + reports.join('\n') : 'patch did nothing (no recognized *** sections)'
}

// Per-workspace agent todos (TodoWrite/TodoRead). Agent self-organization — NOT a workspace
// mutation, so it stays out of MUTATING_TOOLS and never triggers the dataflow rail.
const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
type TodoStatus = (typeof TODO_STATUSES)[number]
interface Todo { content: string; status: TodoStatus; activeForm?: string }
const todos = new Map<string, Todo[]>()
const todoMark = (s: TodoStatus): string => (s === 'completed' ? 'x' : s === 'in_progress' ? '>' : ' ')

// Project context: surface CLAUDE.md / AGENTS.md at the workspace root so the agent obeys
// project-specific instructions. Appended to the system prompt verbatim (highest-priority file
// wins; CLAUDE.md before AGENTS.md). Kept separate from the dataflow SYSTEM so the moat prompt
// stays authoritative and is never overridden by project text.
// Memory files: root first, then nested agent-specific locations (Claude Code puts memory at
// .claude/CLAUDE.md; ZCode/OpenCode at .agents/AGENTS.md or .zcode/AGENTS.md). First present
// file wins so the most specific instruction set is obeyed.
const PROJECT_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', '.agents/AGENTS.md', '.zcode/AGENTS.md']
export function projectContext(workspace: string): string {
  for (const name of PROJECT_FILES) {
    const p = join(workspace, name)
    if (existsSync(p)) {
      try {
        const body = readFileSync(p, 'utf-8').trim()
        if (body) return body
      } catch {
        /* unreadable — skip to the next candidate */
      }
    }
  }
  return ''
}
export function withProjectContext(workspace: string, base: string): string {
  const ctx = projectContext(workspace)
  const listing = skillsListing(workspace)
  let out = base
  if (ctx) out += `\n\n# Project instructions (from ${PROJECT_FILES.join(' / ')} at the workspace root)\n\n${ctx}`
  if (listing) out += listing // skills metadata, always in context (progressive disclosure)
  return out
}

// MCP — lazily start the workspace's configured MCP servers (once; reused across turns) and
// surface their tools as ordinary Tool entries whose run dispatches to the owning server. The
// servers are long-lived child processes; the cache key is the workspace path.
const mcpCache = new Map<string, McpRegistry>()
async function mcpRegistry(workspace: string): Promise<McpRegistry> {
  let reg = mcpCache.get(workspace)
  if (reg) return reg
  reg = new McpRegistry()
  await reg.start(workspace) // a server that fails to start lands in start().errors; it just exposes fewer tools
  mcpCache.set(workspace, reg)
  return reg
}

// The built-in tools PLUS this workspace's MCP tools (each MCP tool wrapped as a Tool whose run
// routes to the registry). Pass the result to callModel AND look tool_use up in it.
export async function mcpAugmentedTools(workspace: string): Promise<Tool[]> {
  try {
    const reg = await mcpRegistry(workspace)
    return [
      ...TOOLS,
      ...reg.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        run: async (input: Record<string, unknown>): Promise<string> => reg.call(t.name, input)
      }))
    ]
  } catch {
    return TOOLS
  }
}

// Drop cached MCP registries (stop their child processes) so the next turn re-reads the config
// and restarts servers — call after editing ~/.grasp/mcp.json.
export function clearMcpCache(): void {
  for (const reg of mcpCache.values()) reg.stop()
  mcpCache.clear()
}

// Per-server health: did each configured MCP server start, and how many tools did it expose?
// Forces a start if none has happened yet this session.
export async function mcpStatus(
  workspace: string
): Promise<{ name: string; ok: boolean; error?: string; toolCount: number }[]> {
  const reg = await mcpRegistry(workspace)
  return reg.status
}

export const TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file, relative to the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(input, { workspace }) {
      if (remoteStatus().active) {
        try { return cap(await remoteReadFile(joinR(remoteWs(), input.path as string))) }
        catch { return `no such file: ${input.path}` }
      }
      const p = inside(workspace, input.path as string)
      if (!existsSync(p)) return `no such file: ${input.path}`
      return cap(readFileSync(p, 'utf-8'))
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file, relative to the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    async run(input, { workspace }) {
      const content = String(input.content ?? '')
      if (remoteStatus().active) {
        await remoteExec(`mkdir -p ${JSON.stringify(dirname(input.path as string))}`, remoteWs())
        await remoteWriteFile(joinR(remoteWs(), input.path as string), content)
        return `wrote ${input.path} (${content.length} bytes)`
      }
      const p = inside(workspace, input.path as string)
      mkdirSync(dirname(p), { recursive: true }) // creating src/x.js must not fail on a fresh dir
      writeFileSync(p, content, 'utf-8')
      return `wrote ${input.path} (${content.length} bytes)`
    }
  },
  {
    name: 'edit_file',
    description:
      'Make a TARGETED edit to an existing file by replacing a unique snippet of its current ' +
      'content. Prefer this over write_file for changes to existing code — it rewrites only the ' +
      'part you specify. The file must already exist and old_string must match the current bytes ' +
      'EXACTLY; a mismatch means your view is stale — re-read the file first. By default ' +
      'old_string must occur exactly once; set replace_all to replace every occurrence.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'replace every occurrence (default false)' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    async run(input, { workspace }) {
      const oldString = String(input.old_string ?? '')
      const newString = String(input.new_string ?? '')
      if (oldString === newString) return 'no change: old_string and new_string are identical.'
      let original: string
      let writeBack: (s: string) => Promise<void>
      if (remoteStatus().active) {
        const rp = joinR(remoteWs(), input.path as string)
        try { original = await remoteReadFile(rp) }
        catch { return `no such file: ${input.path} (edit_file cannot create files — use write_file)` }
        writeBack = async (s) => { await remoteWriteFile(rp, s) }
      } else {
        const p = inside(workspace, input.path as string)
        if (!existsSync(p)) return `no such file: ${input.path} (edit_file cannot create files — use write_file)`
        original = readFileSync(p, 'utf-8')
        writeBack = async (s) => { writeFileSync(p, s, 'utf-8') }
      }
      const occurrences = original.split(oldString).length - 1
      if (occurrences === 0) {
        return `could not edit ${input.path}: old_string not found. Your view of the file is stale — re-read it with read_file, then retry with the exact current text and indentation.`
      }
      if (occurrences > 1 && !input.replace_all) {
        return `could not edit ${input.path}: old_string appears ${occurrences} times. Include more surrounding context so it is unique, or pass replace_all: true.`
      }
      const updated = input.replace_all
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString)
      await writeBack(updated)
      return `edited ${input.path} (${input.replace_all ? occurrences + ' replacements' : '1 replacement'})`
    }
  },
  {
    name: 'notebook_edit',
    description:
      'Edit a single source cell in a Jupyter notebook (.ipynb). Replaces, inserts, or deletes a ' +
      'cell identified by cell_id (preferred) or cell_number (0-based index). new_source is the ' +
      'full new source for the cell (not a diff).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        cell_id: { type: 'string', description: 'the id of the cell to edit (preferred over cell_number)' },
        cell_number: { type: 'number', description: '0-based index of the cell when cell_id is omitted' },
        new_source: { type: 'string', description: 'the full new source for the cell' },
        cell_type: { type: 'string', description: 'required for insert: code | markdown | raw' },
        edit_mode: { type: 'string', description: 'replace (default) | insert | delete' }
      },
      required: ['path', 'new_source']
    },
    async run(input, { workspace }) {
      const p = inside(workspace, input.path as string)
      if (!existsSync(p)) return `no such notebook: ${input.path}`
      let nb: { cells?: Array<Record<string, unknown>> }
      try {
        nb = JSON.parse(readFileSync(p, 'utf-8'))
      } catch {
        return `${input.path} is not valid JSON`
      }
      if (!Array.isArray(nb.cells)) return `${input.path} has no cells array — not a valid .ipynb`
      const mode = (input.edit_mode as string) || 'replace'
      const idx = input.cell_id
        ? nb.cells.findIndex((c) => c.id === input.cell_id)
        : typeof input.cell_number === 'number'
          ? input.cell_number
          : -1
      // ipynb cell source is an array of lines, each except the last ending with \n
      const toSource = (s: string): string[] => {
        const lines = s.replace(/\r\n/g, '\n').split('\n')
        return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l))
      }
      if (mode === 'insert') {
        if (!input.cell_type) return 'insert requires cell_type (code | markdown | raw)'
        const at = idx < 0 ? nb.cells.length - 1 : idx // insert after the located (or last) cell
        nb.cells.splice(at + 1, 0, { cell_type: input.cell_type, source: toSource(String(input.new_source ?? '')), metadata: {} })
        writeFileSync(p, JSON.stringify(nb, null, 1) + '\n', 'utf-8')
        return `inserted a ${input.cell_type} cell after cell ${at} of ${input.path}`
      }
      if (idx < 0 || idx >= nb.cells.length) {
        return `cell not found in ${input.path} (have ${nb.cells.length} cells). Check cell_id/cell_number.`
      }
      if (mode === 'delete') {
        nb.cells.splice(idx, 1)
        writeFileSync(p, JSON.stringify(nb, null, 1) + '\n', 'utf-8')
        return `deleted cell ${idx} of ${input.path}`
      }
      nb.cells[idx] = { ...nb.cells[idx], source: toSource(String(input.new_source ?? '')) }
      writeFileSync(p, JSON.stringify(nb, null, 1) + '\n', 'utf-8')
      return `replaced source of cell ${idx} of ${input.path}`
    }
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory, relative to the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(input, { workspace }) {
      if (remoteStatus().active) {
        const r = await remoteExec(`ls -1Ap ${JSON.stringify((input.path as string) || '.')}`, remoteWs(), 15_000)
        return cap(r.stdout || r.stderr)
      }
      const p = inside(workspace, (input.path as string) || '.')
      return readdirSync(p, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n')
    }
  },
  {
    name: 'run_bash',
    description: 'Run a shell command in the workspace and return combined stdout/stderr.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run(input, { workspace }) {
      if (remoteStatus().active) {
        return remoteExec(String(input.command ?? ''), remoteWs(), 120_000).then((r) =>
          cap(r.stdout + (r.stderr ? `\n${r.stderr}` : '')) + `\n[exit ${r.code}]`)
      }
      return new Promise((res) => {
        const cp = spawn('bash', ['-lc', String(input.command ?? '')], { cwd: workspace, env: cleanEnv() })
        let out = ''
        cp.stdout.on('data', (d) => (out += d))
        cp.stderr.on('data', (d) => (out += d))
        cp.on('error', (e) => res(`error: ${e.message}`))
        cp.on('close', (code) => res(cap(out) + `\n[exit ${code}]`))
      })
    }
  },
  {
    name: 'remote_bash',
    description:
      'Run a shell command on a REMOTE host over SSH. Uses your ~/.ssh/config aliases (or ' +
      'user@host); key/agent auth only (no password prompt); the host key is verified against ' +
      '~/.ssh/known_hosts and an unknown/changed host is REFUSED. Use for remote boxes you ' +
      'already have SSH access to — never for an untrusted host.',
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '~/.ssh/config alias or user@host' },
        command: { type: 'string' }
      },
      required: ['host', 'command']
    },
    async run(input) {
      const res = await sshExec(String(input.host ?? ''), String(input.command ?? ''))
      const out = (res.stdout || '') + (res.stderr ? `\n[stderr]\n${res.stderr}` : '')
      return `ssh ${String(input.host)} — ${res.ok ? 'ok' : 'failed'} (exit ${res.exit})${res.error ? ` ${res.error}` : ''}\n${out.slice(0, 8000) || '(no output)'}`
    }
  },
  {
    name: 'grasp_flow',
    description:
      'SHOW a real execution as the interactive Flow. YOU (the agent) produce a grasp Trace v1 JSON ' +
      'document — the call tree of the code you changed, with the ACTUAL values that flowed through it — ' +
      'and submit it here; grasp validates and renders it, ending in a neutral question. Follow the ' +
      'trace-flow skill: read the repo (README/AGENTS.md/CLAUDE.md) to learn how it runs, install deps, ' +
      'run the real entrypoint, capture the flow of the part you changed. Mark library/plumbing frames ' +
      'meaningful:false so the Flow stays legible. NEVER fabricate a frame — if you could not run it, ' +
      'submit status:"unobservable" with the reason.',
    input_schema: {
      type: 'object',
      properties: {
        trace: { type: 'string', description: 'a Trace v1 JSON document inline' },
        trace_file: { type: 'string', description: 'OR a path to a file containing the Trace v1 JSON (preferred for large traces; write scratch under .grasp/tmp/)' }
      }
    },
    async run(input, { workspace, emit }) {
      let raw: string
      try {
        raw = input.trace_file ? readFileSync(resolvePath(workspace, String(input.trace_file)), 'utf-8') : String(input.trace ?? '')
      } catch (e) { return `could not read trace_file: ${(e as Error).message}` }
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch (e) { return `trace is not valid JSON: ${(e as Error).message}` }
      const err = validateTrace(parsed)
      if (err) return `trace rejected: ${err}. Fix the Trace v1 shape and resubmit (see the trace-flow skill).`
      const obsErr = validateObservation(parsed as TraceDoc)
      if (obsErr) return `trace rejected: ${obsErr}`
      const trace = parsed as TraceDoc
      trace.createdAt = Date.now()
      emit({ type: 'trace', trace })
      if (trace.status === 'unobservable') return `surfaced as unobservable: ${trace.unobservable?.reason}`
      const n = trace.frames.length
      const tail = trace.status === 'threw' ? `threw ${trace.threw?.type}` : `returned ${trace.ret?.repr ?? '(void)'}`
      return `Flow rendered: ${trace.entry} — ${n} frame(s), ${tail}.`
    }
  },
  {
    name: 'grasp_flow_diff',
    description:
      'SHOW the behavioral consequence of your edit as an A→B Flow. Submit two Trace v1 documents — the ' +
      'SAME entrypoint+input observed on the OLD code and the NEW code — and grasp renders which frames ' +
      'and values changed, ending in neutral questions. Produce both traces per the trace-flow skill ' +
      '(trace the new code, then git stash/checkout the old ref and trace again with the same input).',
    input_schema: {
      type: 'object',
      properties: {
        old: { type: 'string', description: 'Trace v1 JSON (inline) of the OLD code' },
        new: { type: 'string', description: 'Trace v1 JSON (inline) of the NEW code' },
        old_file: { type: 'string', description: 'OR a path to the OLD trace JSON (preferred; keep scratch in .grasp/tmp/)' },
        new_file: { type: 'string', description: 'OR a path to the NEW trace JSON (preferred; keep scratch in .grasp/tmp/)' }
      }
    },
    async run(input, { workspace, emit }) {
      let oldT: unknown, newT: unknown
      try {
        const or = input.old_file ? readFileSync(resolvePath(workspace, String(input.old_file)), 'utf-8') : String(input.old ?? '')
        const nr = input.new_file ? readFileSync(resolvePath(workspace, String(input.new_file)), 'utf-8') : String(input.new ?? '')
        oldT = JSON.parse(or); newT = JSON.parse(nr)
      } catch (e) { return `could not read/parse a trace: ${(e as Error).message}` }
      const bad = validateTrace(oldT) || validateTrace(newT)
      if (bad) return `trace rejected: ${bad}. Fix the Trace v1 shape (see the trace-flow skill).`
      const badObs = validateObservation(oldT as TraceDoc) || validateObservation(newT as TraceDoc)
      if (badObs) return `trace rejected: ${badObs}`
      const diff = diffTraces(oldT as TraceDoc, newT as TraceDoc)
      emit({ type: 'trace_diff', diff })
      if (diff.empty) return `no behavioral change surfaced for ${diff.entry} on this input.`
      return `A→B flow: ${diff.changedCount} change(s). Questions: ${diff.questions.slice(0, 4).join(' | ')}`
    }
  },
  {
    name: 'grasp_fuzz_diff',
    description:
      'Differential fuzz — the diff that actually answers "did my edit break something". A single ' +
      'input proves nothing about inputs you did not try; this varies the input space and surfaces ' +
      'EVERY input where the OLD and NEW code diverge. YOU (the agent) generate a spread of inputs ' +
      '(valid, boundary, malformed, wrong-type, missing — seed it deterministically), trace the SAME ' +
      'input on old and new for each, and write the cases to a JSON file: either a bare array of ' +
      '{input, old, new} (each old/new a Trace v1 doc), or {cases: [...], claim?, axes?}. claim is your ' +
      'PROPOSED characterization of the divergence — {where: <Pred over the input>, effect: {old?: ' +
      '{status, threwType, returns}, new?: {...}}} — grasp CHECKS it per case against the divergence it ' +
      'computed itself and renders consistent / mismatched (counterexamples) / untested (no straddle) / ' +
      'enumeration (no compression). Pred ops: cmp {path, rel, value}, cmpf {path, rel, other} (field vs field), and/or, not, has, ' +
      'type, len — max 24 nodes; propose the boundary from the diverged inputs, then add STRADDLING ' +
      'cases to falsify yourself before submitting. axes declares what the spread varied vs held ' +
      'constant ({varied: [{path, note?}], held: [{path}]}); grasp verifies both against the cases. ' +
      'Pairs with an unobservable side are dropped, never rendered as change. grasp diffs every pair ' +
      'and renders only the divergences with an honest scope statement (N tried, K diverged). See the ' +
      'fuzz-diff skill. grasp never calls a change safe.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'what was exercised (e.g. src/auth.ts:login)' },
        cases_file: { type: 'string', description: 'path to the cases JSON — bare array of {input, old, new} or {cases, claim?, axes?}; write it under .grasp/tmp/' }
      },
      required: ['entry', 'cases_file']
    },
    async run(input, { workspace, emit }) {
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(resolvePath(workspace, String(input.cases_file)), 'utf-8')) }
      catch (e) { return `could not read/parse cases_file: ${(e as Error).message}` }
      let rawCases: unknown = parsed
      let claim: FuzzClaim | undefined
      let axes: FuzzAxes | undefined
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>
        rawCases = o.cases
        // A malformed claim/axes is REFUSED, not silently ignored — grasp renders checked claims only.
        if (o.claim !== undefined) {
          const ce = validateClaim(o.claim)
          if (ce) return `claim rejected: ${ce}. Fix the claim (or omit it) and resubmit.`
          claim = o.claim as FuzzClaim
        }
        if (o.axes !== undefined) {
          const ae = validateAxes(o.axes)
          if (ae) return `axes rejected: ${ae}. Fix the axes (or omit them) and resubmit.`
          axes = o.axes as FuzzAxes
        }
      }
      if (!Array.isArray(rawCases)) return 'cases_file must be a JSON array of {input, old, new}, or {cases: [...], claim?, axes?}'
      const cases: FuzzCase[] = []
      let rejected = 0
      for (const c of rawCases as Record<string, unknown>[]) {
        if (validateTrace(c.old) || validateTrace(c.new)) { rejected++; continue }
        cases.push({
          label: typeof c.label === 'string' ? c.label : undefined,
          scenario: typeof c.scenario === 'string' ? c.scenario : undefined,
          input: c.input,
          old: c.old as TraceDoc,
          new: c.new as TraceDoc
        })
      }
      if (cases.length === 0) return `no valid cases (${rejected} rejected). Each case needs valid Trace v1 old & new (see the fuzz-diff skill).`
      const fuzz = buildFuzzDiff(String(input.entry), cases, claim, axes)
      // Behavior model (spec-v2): check every rule against these observed cases. grasp
      // recomputes divergence itself; "violated" replays the human's own ratified judgment.
      const { model, note: modelNote } = loadModel(workspace, resolvePath(workspace, String(input.cases_file)))
      if (model) {
        const runs: CaseRun[] = cases
          .filter((c) => c.old.status !== 'unobservable' && c.new.status !== 'unobservable')
          .map((c) => ({ label: c.label, scenario: c.scenario, input: c.input, newT: c.new, diverged: !diffTraces(c.old, c.new).empty }))
        const novelChanges = new Map<number, string>()
        runs.forEach((r, i) => {
          if (!r.diverged) return
          const d = cases.find((c) => c.input === r.input)
          if (d) novelChanges.set(i, diffTraces(d.old, d.new).questions[0]?.replace(' — intended?', '') ?? 'behavior diverged')
        })
        fuzz.report = checkModel(model, runs, novelChanges)
        const uncovered = (model.rules ?? [])
          .filter((r) => r.check && !r.staged)
          .filter((r) => fuzz.report?.rows.find((row) => row.id === r.id)?.status === 'untested')
        if (uncovered.length)
          fuzz.report.scope += ` COVERAGE GAP: compiled rule${uncovered.length === 1 ? '' : 's'} ${uncovered
            .map((r) => `${r.id} (scenario ${r.check?.scenario})`)
            .join(', ')} had no covering cases — generate scenarios that exercise them.`
      } else {
        fuzz.report = null
      }
      emit({ type: 'fuzz_diff', fuzz })
      const note = rejected ? ` (${rejected} case(s) rejected as invalid Trace v1)` : ''
      const claimNote = fuzz.claim ? ` ${fuzz.claim.summary}` : ''
      const axesNote = fuzz.axes && fuzz.axes.issues.length ? ` Axes: ${fuzz.axes.issues.join('; ')}.` : ''
      const reportNote = fuzz.report ? ` ${fuzz.report.scope}` : modelNote ? ` ${modelNote}` : ''
      return `${fuzz.scope}${note}${claimNote}${axesNote}${reportNote}` + (fuzz.diverged ? ` Questions: ${fuzz.questions.slice(0,4).join(' | ')}` : '')
    }
  },
  {
    name: 'grasp_intro',
    description:
      'Render the workspace INTRODUCTION as a deterministic surface (first contact / the start ' +
      'command). Submit typed slots only: how (plain words, how this repo runs, <=600 chars), flows ' +
      '(1-8 entries {name <=60, what <=160} — features by NAME the human could ask to see), and ' +
      'suggestion (<=240 chars, the one next step). grasp itself appends the behavior-model rules ' +
      'section from .grasp/model.yaml — do NOT restate rules. After submitting, keep chat to one line.',
    input_schema: {
      type: 'object',
      properties: {
        how: { type: 'string' },
        flows: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, what: { type: 'string' } }, required: ['name', 'what'] } },
        suggestion: { type: 'string' }
      },
      required: ['how', 'flows', 'suggestion']
    },
    async run(input, { workspace, emit }) {
      const how = String(input.how ?? '').trim()
      const suggestion = String(input.suggestion ?? '').trim()
      const flowsRaw = Array.isArray(input.flows) ? (input.flows as { name?: unknown; what?: unknown }[]) : []
      if (!how || how.length > 600) return 'intro rejected: how must be 1-600 chars of plain words.'
      if (!suggestion || suggestion.length > 240) return 'intro rejected: suggestion must be 1-240 chars.'
      if (flowsRaw.length < 1 || flowsRaw.length > 8) return 'intro rejected: flows must have 1-8 entries {name, what}.'
      const flows: { name: string; what: string }[] = []
      for (const f of flowsRaw) {
        const name = String(f.name ?? '').trim()
        const what = String(f.what ?? '').trim()
        if (!name || name.length > 60) return 'intro rejected: each flow name must be 1-60 chars (a feature name, not a symbol).'
        if (!what || what.length > 160) return 'intro rejected: each flow what must be 1-160 chars.'
        flows.push({ name, what })
      }
      // The rules section comes from the model file, read by grasp — never the agent's restatement.
      const { model, note, home } = loadModel(workspace)
      const rules = (model?.rules ?? []).map((r) => ({
        id: r.id,
        text: r.text,
        status: (r.staged ? 'staged' : r.check ? 'compiled' : 'uncompiled') as 'staged' | 'uncompiled' | 'compiled'
      }))
      const intro: IntroDoc = { workspace: home, how, flows, rules, suggestion }
      emit({ type: 'intro', intro })
      return `introduction rendered (${flows.length} flows, ${rules.length} rules from model.yaml${note ? ` — NOTE: ${note}` : model ? '' : ' — no model file yet'}). Keep chat to one line.`
    }
  },
  {
    name: 'use_skill',
    description:
      'Load a reusable SKILL — a packaged set of instructions for a task (e.g. "observe-change", ' +
      '"harden-input"). Call with NO name to LIST the available skills; call with a name to load ' +
      "that skill's instructions and then follow them. Skills orchestrate grasp's observe/diff/fuzz " +
      'loop; they guide, they never judge. Prefer a matching skill before improvising a workflow. A ' +
      'directory skill may bundle reference files (references/, scripts/) — when you load it, the base ' +
      'directory is included; read those files with read_file at the relative paths named in the body.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'the skill name, or omit to list all skills' } }
    },
    async run(input, { workspace }) {
      const name = String(input.name ?? '').trim()
      if (!name) {
        const list = listSkills(workspace).filter((s) => s.enabled)
        if (!list.length) return 'No skills installed. A skill is a directory with SKILL.md (preferred — may bundle references/, scripts/) or a flat .md, in ~/.grasp/skills or <project>/.grasp/skills.'
        return 'Available skills (call use_skill with a name to load one):\n' + list.map((s) => {
          const desc = s.description.slice(0, 250)
          return `- ${s.name}: ${desc}${s.warning ? ` [note: ${s.warning}]` : ''}`
        }).join('\n')
      }
      const s = readSkill(workspace, name)
      if (!s) return `No skill named "${name}". Call use_skill with no name to list available skills.`
      // The base-directory annotation is the linchpin of progressive disclosure: it lets a body
      // instruction like "read references/foo.md" resolve to an unambiguous absolute path.
      const base = s.baseDir
        ? `\n\n---\nBase directory for this skill: ${s.baseDir}\nRelative paths in this skill (e.g. 'read references/foo.md') are relative to this base directory.`
        : ''
      const warn = s.warning ? `\n\n[note: ${s.warning}]` : ''
      return `Skill "${s.name}" — follow these instructions:\n\n${s.body}${base}${warn}`
    }
  },
  {
    name: 'TodoWrite',
    description:
      'Track your plan as a short ordered todo list. Use for any multi-step task (3+ steps): ' +
      'write the list up front, keep exactly one item in_progress, and mark items completed as ' +
      'you finish them. Each call REPLACES the whole list. This is agent self-organization — it ' +
      'does not touch the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', description: 'pending | in_progress | completed' },
              activeForm: { type: 'string', description: 'present-continuous label, e.g. "Editing file.ts"' }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    },
    async run(input, { workspace, emit }) {
      const raw = Array.isArray(input.todos) ? (input.todos as Array<{ content?: unknown; status?: unknown; activeForm?: unknown }>) : []
      const list: Todo[] = raw
        .filter((t) => t && typeof t.content === 'string' && t.content)
        .map((t) => ({
          content: String(t.content),
          status: (TODO_STATUSES as readonly string[]).includes(t.status as string) ? (t.status as TodoStatus) : 'pending',
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined
        }))
      todos.set(workspace, list)
      emit({ type: 'todos', workspace, items: list })
      return `todos updated (${list.length}):\n` + list.map((t, i) => `${todoMark(t.status)} ${i + 1}. ${t.content}`).join('\n')
    }
  },
  {
    name: 'TodoRead',
    description: 'Read the current todo list for this workspace.',
    input_schema: { type: 'object', properties: {} },
    async run(_input, { workspace }) {
      const list = todos.get(workspace) ?? []
      if (!list.length) return 'No todos yet. Use TodoWrite to plan a multi-step task.'
      return list.map((t, i) => `${todoMark(t.status)} ${i + 1}. ${t.content}`).join('\n')
    }
  },
  {
    name: 'task',
    description:
      'Delegate a focused, self-contained sub-task to a subagent (e.g. "investigate how X ' +
      'is validated", "make the edit to file Y and observe it"). The subagent works on its ' +
      'own with the file/observe tools and returns a concise result. Use for parallelizable ' +
      'or well-scoped work so your main thread stays focused. Give it one clear objective.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'a short label for the sub-task' },
        prompt: { type: 'string', description: 'the full objective + context the subagent needs' }
      },
      required: ['prompt']
    },
    async run(input, ctx) {
      if (!ctx.subagent) return 'subagents are not available on this backend.'
      return ctx.subagent(String(input.prompt), ctx.toolId ?? 'task')
    }
  },
  {
    name: 'ask_user',
    description:
      'Ask the human a structured multiple-choice question when you genuinely need their input to proceed (choosing between approaches, confirming scope, picking a target). Use this INSTEAD of guessing when the answer changes the work — including in plan mode, before proposing. Do not use it for anything you can reasonably decide yourself. Returns their answer (the chosen option label, or their own custom text), or "(dismissed)" if they skipped. Max 6 options; keep labels short.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask.' },
        header: { type: 'string', description: 'A short topic label, e.g. "App type".' },
        options: {
          type: 'array',
          maxItems: 6,
          items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] }
        },
        multiSelect: { type: 'boolean', description: 'Allow choosing more than one option.' }
      },
      required: ['question', 'options']
    },
    async run(input, ctx) {
      const rawOpts = Array.isArray(input.options) ? input.options : []
      const options = rawOpts.slice(0, 6).map((o: Record<string, unknown>) => ({
        label: String(o.label ?? ''),
        description: o.description ? String(o.description) : undefined
      }))
      const header = input.header ? String(input.header) : undefined
      const ans = await requestElicitation(ctx.emit, {
        header,
        question: String(input.question ?? ''),
        options,
        multiSelect: !!input.multiSelect,
        source: 'ask_user'
      })
      return ans ?? '(dismissed)'
    }
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content (HTML stripped; JSON/text left as-is), truncated to ~8KB. Use for reading a doc page, an API reference, a raw file, or any URL the user gave. Treat content as unverified external material.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run(input) {
      const url = String(input.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return 'web_fetch needs an absolute http(s) URL.'
      const r = await fetchText(url)
      if (!r.ok) return `fetch failed: ${r.error}`
      return `${url}\n(status ${r.status}${r.contentType ? `, ${r.contentType}` : ''})\n\n${r.text ?? '(empty)'}`
    }
  },
  {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo, no key) and return up to 8 results (title, URL, snippet). Use for current info, docs, or solutions; then web_fetch a result for full content. Best-effort — markup may change.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run(input) {
      const q = String(input.query ?? '').trim()
      if (!q) return 'web_search needs a query.'
      const r = await searchWeb(q)
      if (!r.ok) return `search failed: ${r.error}`
      if (!r.results?.length) return `no results for "${q}".`
      return r.results.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n')
    }
  },
  {
    name: 'Skill',
    description: 'Load a reusable SKILL by name (Claude-Code-compatible alias of use_skill). Call with NO name to list available skills; with a name to load its instructions and follow them.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } } },
    async run(input, { workspace }) {
      const name = String(input.name ?? '').trim()
      if (!name) {
        const list = listSkills(workspace).filter((s) => s.enabled)
        if (!list.length) return 'No skills installed.'
        return 'Available skills:\n' + list.map((s) => `- ${s.name}: ${s.description.slice(0, 200)}`).join('\n')
      }
      const s = readSkill(workspace, name)
      if (!s) return `No skill named "${name}".`
      return `Skill "${s.name}":\n\n${s.body}`
    }
  },
  {
    name: 'goal',
    description: "Read or set the session's single objective — the one-line goal of this task. Set it when the task starts or when the user states intent; read it when you lose the thread. Pass set:'' to clear. (Objective tracker; GoalRead-equivalent.)",
    input_schema: { type: 'object', properties: { set: { type: 'string', description: 'set the objective to this (omit to read)' } } },
    async run(input, { workspace }) {
      if (typeof input.set === 'string') {
        const g = input.set.trim()
        if (g) { goals.set(workspace, g); return `objective set: ${g}` }
        goals.delete(workspace); return 'objective cleared.'
      }
      return goals.get(workspace) ?? '(no objective set)'
    }
  },
  {
    name: 'ApplyPatch',
    description: "Apply a Claude-Code-style patch. Format: '*** Begin Patch', then sections — '*** Add File: <path>' (content follows), '*** Delete File: <path>', or '*** Update File: <path>' followed by ' '/'-'/'+' prefixed hunk lines (optionally with @@ anchors) — ending with '*** End Patch'. Prefer edit_file for a single change; use this for coordinated multi-file edits.",
    input_schema: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
    async run(input, { workspace }) {
      return applyPatch(workspace, String(input.patch ?? ''))
    }
  },
  {
    name: 'explore',
    description: 'Delegate READ-ONLY research to an exploration subagent — e.g. "find every place X is validated", "where is config loaded". It reads/searches and returns findings; it does not edit. Use it to gather context without losing your main thread.',
    input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    async run(input, ctx) {
      if (!ctx.subagent) return 'subagents are not available on this backend.'
      return ctx.subagent(String(input.prompt), ctx.toolId ?? 'explore', { system: EXPLORE_SYSTEM, tools: EXPLORE_TOOLS })
    }
  }
]

// The subagent toolset: everything EXCEPT task itself (delegation is depth-1, no recursion).
export const SUBAGENT_TOOLS = TOOLS.filter((t) => t.name !== 'task')
export const SUBAGENT_SYSTEM =
  SYSTEM +
  ' You are a SUBAGENT handling one focused sub-task. Do the work with your tools, then end' +
  ' with a concise result for the main agent — what you found or did, and any observed' +
  ' dataflow question. Do not delegate further.'

// Explore: a read-only research subagent (keeps run_bash for grep, but the system prompt
// forbids mutation; edit/write tools are excluded so it cannot change files).
export const EXPLORE_TOOLS = SUBAGENT_TOOLS.filter((t) => !EDIT_TOOLS.has(t.name))
export const EXPLORE_SYSTEM =
  SYSTEM +
  ' You are an EXPLORATION subagent. READ and SEARCH ONLY — do not edit, write, or run ' +
  'mutating commands. Investigate the question, then return a concise, evidence-backed answer ' +
  'with file paths and line references. Do not delegate further.'

// grasp does NOT execute the target codebase. The AGENT is the compiler: it reads the repo
// (README / AGENTS.md / CLAUDE.md), installs deps, runs the real entrypoint, observes the flow
// of the part it changed, and submits nodes via grasp_flow. These remain as no-op seams so the
// backends that reference them keep compiling; there is no host-side tracing to trigger.
export function rememberWatch(_workspace: string, _entrypoint: string, _input?: string, _language?: string): void {
  /* no-op: grasp no longer runs code; the agent submits traces explicitly */
}

export async function flowNow(_workspace: string, _emit: Emit): Promise<{ ok: boolean; error?: string }> {
  return {
    ok: false,
    error: 'grasp renders the Flow the agent produces — ask the agent to trace the change (it reads the repo, runs the real entrypoint, and submits the flow).'
  }
}

export async function liveSurface(_workspace: string, _mutated: boolean, _emit: Emit): Promise<void> {
  /* no-op: the agent surfaces the Flow via grasp_flow after it observes a real run */
}
