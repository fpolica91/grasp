// The shared tool registry for grasp's OWN tool-use loops (GLM, OpenAI). File and
// shell tools are workspace-scoped; the grasp_* tools are the instrument itself —
// they run code FOR REAL and surface observed dataflow into the UI. Claude Code
// brings its own tools, so it does not use this registry (but shares liveSurface).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { diff, fuzz, observe } from '../engine'
import { listSkills, readSkill } from '../skills'
import type { Emit } from './types'

const OUT_CAP = 8000

export const SYSTEM = [
  'You are grasp, a coding agent inside the post-editor. You edit code with the file and',
  'shell tools. But you do NOT assert a change "works", is "fixed", or is "safe".',
  '',
  "grasp's whole reason to exist is the OBSERVED DATAFLOW rail: it runs the code FOR REAL",
  'and shows the human the values it bound and the paths it took. That rail is populated',
  'by grasp_observe / grasp_diff — and ONLY by them. This is non-negotiable:',
  '',
  '• To verify ANY code you write or change, you MUST use grasp_observe (brand-new code) or',
  '  grasp_diff (edited existing code) on the entrypoint. This is your PRIMARY way to show a',
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
  '  and call grasp_observe on THAT. Do not shrug and reach for run_bash — extract, then observe.',
  '• run_bash is for genuinely non-observable steps only: installing deps, starting a server,',
  '  a build. When you use it to RUN logic because you think there is no entrypoint, stop and',
  '  extract an entrypoint first.',
  '',
  'Present exactly what grasp_observe/grasp_diff surface and end in the neutral question they',
  'give you; the human adjudicates against business rules only they know. Never render a verdict.'
].join(' ')

// PLAN MODE: inspect-only. The agent may read and observe, never mutate; its final
// message is the proposed plan, which grasp holds for human approval before execution.
export const PLAN_TOOL_NAMES = new Set(['read_file', 'list_dir', 'grasp_observe'])
export const PLAN_SYSTEM =
  SYSTEM +
  ' PLAN MODE IS ACTIVE: you may only inspect (read_file, list_dir, grasp_observe). You cannot' +
  ' edit files or run commands. Investigate, then end with a concrete step-by-step plan of the' +
  ' exact changes you propose (files, edits, and how the change should be observed). The human' +
  ' will approve the plan before anything is executed.'

// ASK MODE: these tools change the workspace, so they pause for human approval.
export const MUTATING_TOOLS = new Set(['write_file', 'run_bash'])

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
      writeFileSync(p, String(input.content ?? ''), 'utf-8')
      return `wrote ${input.path} (${String(input.content ?? '').length} bytes)`
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
    name: 'grasp_observe',
    description:
      'Run an entrypoint FOR REAL and get the observed dataflow — what values it binds, ' +
      'the paths it takes — ending in a neutral question. Use this after you change code ' +
      'to show what the change does, instead of asserting it works.',
    input_schema: {
      type: 'object',
      properties: {
        entrypoint: { type: 'string' },
        input: { type: 'string', description: 'JSON kwargs' },
        language: {
          type: 'string',
          description:
            "the target language when it can't be auto-detected from repo files (e.g. a .js module " +
            "with no package.json). One of: py, js, ts, go, java, csharp, cpp. Omit to auto-detect."
        }
      },
      required: ['entrypoint']
    },
    async run(input, { workspace, emit }) {
      const language = input.language ? String(input.language) : undefined
      const res = await observe({ repo: workspace, entrypoint: String(input.entrypoint), input: input.input as string, language })
      if (res.observed && res.graph) {
        rememberWatch(workspace, String(input.entrypoint), input.input as string, language) // auto-re-observe on later edits
        emit({ type: 'dataflow', graph: res.graph }) // surface the graph in the UI
        const qs = res.graph.questions.length ? res.graph.questions.join(' | ') : '(no open question)'
        return `observed dataflow for ${input.entrypoint}. Open question(s): ${qs}`
      }
      return `could not observe: ${res.error ?? 'unknown'}`
    }
  },
  {
    name: 'grasp_diff',
    description:
      'After you EDIT existing code, show what your change did to the BEHAVIOR: observes the ' +
      'entrypoint OLD (git ref, default HEAD — before your edits) vs NEW (your edited working ' +
      'tree) for the same input, and returns the A->B dataflow change, ending in a neutral ' +
      'question. Use this instead of asserting your edit "works". Requires a git repo workspace.',
    input_schema: {
      type: 'object',
      properties: {
        entrypoint: { type: 'string' },
        input: { type: 'string', description: 'JSON kwargs' },
        old_ref: { type: 'string', description: 'git ref for the OLD side (default HEAD)' },
        language: {
          type: 'string',
          description:
            "the target language when it can't be auto-detected from repo files. One of: py, js, ts, " +
            'go, java, csharp, cpp. Omit to auto-detect.'
        }
      },
      required: ['entrypoint']
    },
    async run(input, { workspace, emit }) {
      const language = input.language ? String(input.language) : undefined
      const res = await diff({
        repo: workspace,
        entrypoint: String(input.entrypoint),
        oldRef: (input.old_ref as string) || 'HEAD',
        input: input.input as string,
        language
      })
      if (res.ok && res.graphDiff) {
        rememberWatch(workspace, String(input.entrypoint), input.input as string, language) // auto-re-observe on later edits
        emit({ type: 'dataflow_diff', diff: res.graphDiff })
        if (res.graphDiff.empty) return `no behavioral change surfaced for ${input.entrypoint} on this input.`
        const qs = res.graphDiff.questions.length ? res.graphDiff.questions.join(' | ') : '(no question)'
        return `dataflow changed A->B for ${input.entrypoint} (${res.graphDiff.changed_count} change(s)). Question(s): ${qs}`
      }
      return `could not diff: ${res.error ?? 'unknown'}`
    }
  },
  {
    name: 'grasp_fuzz',
    description:
      'Pressure-test an entrypoint across many inputs (the new stack trace): vary the input ' +
      'per a JSON Schema you provide and get which operands BENT across inputs, which inputs ' +
      'RAISED, and the gaps — each with a reproducing input. Use to expose edge cases a single ' +
      'input misses. Python only; walled (network denied) by default. The full result is ' +
      'RETURNED to you directly and rendered in grasp’s dataflow rail — it writes NO files; ' +
      'do not look for output files afterward. Present the result and stop.',
    input_schema: {
      type: 'object',
      properties: {
        entrypoint: { type: 'string' },
        schema: { type: 'string', description: 'a JSON Schema (as a string) describing the entrypoint kwargs' },
        variants: { type: 'number', description: 'number of inputs to try (default 16)' }
      },
      required: ['entrypoint', 'schema']
    },
    async run(input, { workspace, emit }) {
      const res = await fuzz({
        repo: workspace,
        entrypoint: String(input.entrypoint),
        schema: String(input.schema),
        variants: typeof input.variants === 'number' ? input.variants : undefined
      })
      if (res.ok && res.report) {
        emit({ type: 'fuzz', report: res.report })
        const nv = res.report.varied.length
        const nr = res.report.raises.length
        return `fuzzed ${input.entrypoint}: ${nv} operand(s) varied across inputs, ${nr} raise(s). Reproducing inputs attached.`
      }
      return `could not fuzz: ${res.error ?? 'unknown'}`
    }
  },
  {
    name: 'use_skill',
    description:
      'Load a reusable SKILL — a packaged set of instructions for a task (e.g. "observe-change", ' +
      '"harden-input"). Call with NO name to LIST the available skills; call with a name to load ' +
      "that skill's instructions and then follow them. Skills orchestrate grasp's observe/diff/fuzz " +
      'loop; they guide, they never judge. Prefer a matching skill before improvising a workflow.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'the skill name, or omit to list all skills' } }
    },
    async run(input, { workspace }) {
      const name = String(input.name ?? '').trim()
      if (!name) {
        const list = listSkills(workspace)
        if (!list.length) return 'No skills installed. Skills are .md files in ~/.grasp/skills or <project>/.grasp/skills.'
        return 'Available skills (call use_skill with a name to load one):\n' + list.map((s) => `- ${s.name}: ${s.description}`).join('\n')
      }
      const s = readSkill(workspace, name)
      return s ? `Skill "${s.name}" — follow these instructions:\n\n${s.body}` : `No skill named "${name}". Call use_skill with no name to list available skills.`
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

// AUTO-OBSERVE — no manual "watch" config. The moment the agent observes/diffs an
// entrypoint (which it does as part of its work), grasp REMEMBERS it per workspace;
// then after every subsequent edit it re-observes that entrypoint automatically, so the
// dataflow updates on every iteration without the human typing a function name.
const lastWatch = new Map<string, { entrypoint: string; input?: string; language?: string }>()

export function rememberWatch(workspace: string, entrypoint: string, input?: string, language?: string): void {
  if (entrypoint) lastWatch.set(workspace, { entrypoint, input, language })
}

// On-demand Flow (the call-to-action when auto is off, or a manual refresh any time):
// re-observe the remembered entrypoint right now. Honest when there's nothing to run.
export async function flowNow(workspace: string, emit: Emit): Promise<{ ok: boolean; error?: string }> {
  const w = lastWatch.get(workspace)
  if (!w?.entrypoint) {
    return {
      ok: false,
      error: 'Nothing observed yet in this project — ask the agent to run or observe a function first.'
    }
  }
  await liveSurface(workspace, true, emit)
  return { ok: true }
}

export async function liveSurface(workspace: string, mutated: boolean, emit: Emit): Promise<void> {
  const w = lastWatch.get(workspace)
  if (!mutated || !w?.entrypoint) return
  // Prefer the A->B change (HEAD vs working tree). But a brand-new entrypoint has no HEAD
  // version, so the diff is empty or errors — fall back to a plain observation so the live
  // rail still shows what the code now does, rather than going silently blank.
  const d = await diff({ repo: workspace, entrypoint: w.entrypoint, oldRef: 'HEAD', input: w.input, language: w.language })
  if (d.ok && d.graphDiff && !d.graphDiff.empty) {
    emit({ type: 'dataflow_diff', diff: d.graphDiff })
    return
  }
  const o = await observe({ repo: workspace, entrypoint: w.entrypoint, input: w.input, language: w.language })
  if (o.observed && o.graph) emit({ type: 'dataflow', graph: o.graph })
}
