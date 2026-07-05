// The shared tool registry for grasp's OWN tool-use loops (GLM, OpenAI). File and
// shell tools are workspace-scoped; the grasp_* tools are the instrument itself —
// they run code FOR REAL and surface observed dataflow into the UI. Claude Code
// brings its own tools, so it does not use this registry (but shares liveSurface).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { validateTrace, diffTraces, buildFuzzDiff, type TraceDoc, type FuzzCase } from '../../shared/trace'
import { listSkills, readSkill, skillsListing } from '../skills'
import type { Emit } from './types'
import { McpRegistry } from './mcp'

function resolvePath(workspace: string, p: string): string {
  return p.startsWith('/') ? p : join(workspace || '.', p)
}


const OUT_CAP = 8000

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
  '  change did what you intended — do it proactively, not only when asked.',
  '• NEVER verify by writing an ad-hoc test script and running it through run_bash (e.g.',
  "  `node -e ...`, a throwaway test.py, a harness file). That runs the code but leaves grasp's",
  '  dataflow rail BLIND — the human sees nothing. An ad-hoc harness is a failure, not a shortcut.',
  '• They work across languages (Python, JS/TS, Go, Java, C#, C++). Entrypoint form:',
  '  module.func (py/js/ts), path/file.go:Func, Class.method (java), Namespace.Class.Method (c#).',
  '  grasp auto-detects the language from repo files; if a repo has no marker (e.g. a bare .js',
  '  module and no package.json), pass the `language` argument explicitly (py/js/ts/go/java/csharp/cpp).',
  '• If the code is UI/DOM-coupled with no directly-callable entrypoint (a frontend handler, a',
  '  React component), SEPARATE the core logic into a plain callable function in its own module',
  '  and observe THAT and submit via grasp_flow. Do not shrug and reach for run_bash — extract, then trace.',
  '• run_bash is for genuinely non-observable steps only: installing deps, starting a server,',
  '  a build. When you use it to RUN logic because you think there is no entrypoint, stop and',
  '  extract an entrypoint first.',
  '',
  '• Prefer edit_file over write_file for changes to existing files — it rewrites only the',
  '  snippet you specify, so it is safer; use write_file to create a file or replace it entirely.',
  '  Use TodoWrite to plan any task with three or more steps.',
  '',
  'Present exactly what grasp_flow/grasp_flow_diff surface and end in the neutral question they',
  'give you; the human adjudicates against business rules only they know. Never render a verdict.'
].join(' ')

// PLAN MODE: inspect-only. The agent may read and observe, never mutate; its final
// message is the proposed plan, which grasp holds for human approval before execution.
export const PLAN_TOOL_NAMES = new Set(['read_file', 'list_dir', 'grasp_flow'])
export const PLAN_SYSTEM =
  SYSTEM +
  ' PLAN MODE IS ACTIVE: you may only inspect (read_file, list_dir, grasp_flow). You cannot' +
  ' edit files or run commands. Investigate, then end with a concrete step-by-step plan of the' +
  ' exact changes you propose (files, edits, and how the change should be observed). The human' +
  ' will approve the plan before anything is executed.'

// ASK MODE: these tools change the workspace, so they pause for human approval. They are also
// the set that triggers liveSurface (a code change should re-run the observed dataflow).
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit', 'run_bash'])

// A subagent runner: run a focused sub-task and return its final text. Events it emits
// are tagged with the parent task's id so the UI nests them.
export type SubagentRunner = (prompt: string, parentId: string) => Promise<string>

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
const PROJECT_FILES = ['CLAUDE.md', 'AGENTS.md']
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

export const TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file, relative to the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(input, { workspace }) {
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
      const p = inside(workspace, input.path as string)
      mkdirSync(dirname(p), { recursive: true }) // creating src/x.js must not fail on a fresh dir
      writeFileSync(p, String(input.content ?? ''), 'utf-8')
      return `wrote ${input.path} (${String(input.content ?? '').length} bytes)`
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
      const p = inside(workspace, input.path as string)
      if (!existsSync(p)) return `no such file: ${input.path} (edit_file cannot create files — use write_file)`
      const oldString = String(input.old_string ?? '')
      const newString = String(input.new_string ?? '')
      if (oldString === newString) return 'no change: old_string and new_string are identical.'
      const original = readFileSync(p, 'utf-8')
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
      writeFileSync(p, updated, 'utf-8')
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
      const p = inside(workspace, (input.path as string) || '.')
      return readdirSync(p, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n')
    }
  },
  {
    name: 'run_bash',
    description: 'Run a shell command in the workspace and return combined stdout/stderr.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run(input, { workspace }) {
      return new Promise((res) => {
        const cp = spawn('bash', ['-lc', String(input.command ?? '')], { cwd: workspace })
        let out = ''
        cp.stdout.on('data', (d) => (out += d))
        cp.stderr.on('data', (d) => (out += d))
        cp.on('error', (e) => res(`error: ${e.message}`))
        cp.on('close', (code) => res(cap(out) + `\n[exit ${code}]`))
      })
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
        trace_file: { type: 'string', description: 'OR a path to a file containing the Trace v1 JSON (preferred for large traces)' }
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
        old_file: { type: 'string', description: 'OR a path to the OLD trace JSON (preferred)' },
        new_file: { type: 'string', description: 'OR a path to the NEW trace JSON (preferred)' }
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
      'input on old and new for each, and write a JSON array of {input, old, new} (each old/new a ' +
      'Trace v1 doc) to a file; grasp diffs every pair and renders only the divergences with an honest ' +
      'scope statement (N tried, K diverged). See the fuzz-diff skill. grasp never calls a change safe.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'what was exercised (e.g. src/auth.ts:login)' },
        cases_file: { type: 'string', description: 'path to a JSON array of {input, old, new} (old/new are Trace v1 docs)' }
      },
      required: ['entry', 'cases_file']
    },
    async run(input, { workspace, emit }) {
      let arr: unknown
      try { arr = JSON.parse(readFileSync(resolvePath(workspace, String(input.cases_file)), 'utf-8')) }
      catch (e) { return `could not read/parse cases_file: ${(e as Error).message}` }
      if (!Array.isArray(arr)) return 'cases_file must contain a JSON array of {input, old, new}'
      const cases: FuzzCase[] = []
      let rejected = 0
      for (const c of arr as Record<string, unknown>[]) {
        if (validateTrace(c.old) || validateTrace(c.new)) { rejected++; continue }
        cases.push({ input: c.input, old: c.old as TraceDoc, new: c.new as TraceDoc })
      }
      if (cases.length === 0) return `no valid cases (${rejected} rejected). Each case needs valid Trace v1 old & new (see the fuzz-diff skill).`
      const fuzz = buildFuzzDiff(String(input.entry), cases)
      emit({ type: 'fuzz_diff', fuzz })
      const note = rejected ? ` (${rejected} case(s) rejected as invalid Trace v1)` : ''
      return `${fuzz.scope}${note}` + (fuzz.diverged ? ` Questions: ${fuzz.questions.slice(0,4).join(' | ')}` : '')
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
  }
]

// The subagent toolset: everything EXCEPT task itself (delegation is depth-1, no recursion).
export const SUBAGENT_TOOLS = TOOLS.filter((t) => t.name !== 'task')
export const SUBAGENT_SYSTEM =
  SYSTEM +
  ' You are a SUBAGENT handling one focused sub-task. Do the work with your tools, then end' +
  ' with a concise result for the main agent — what you found or did, and any observed' +
  ' dataflow question. Do not delegate further.'

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
