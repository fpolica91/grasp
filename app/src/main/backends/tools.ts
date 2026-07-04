// The shared tool registry for grasp's OWN tool-use loops (GLM, OpenAI). File and
// shell tools are workspace-scoped; the grasp_* tools are the instrument itself —
// they run code FOR REAL and surface observed dataflow into the UI. Claude Code
// brings its own tools, so it does not use this registry (but shares liveSurface).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { diff, fuzz, observe } from '../engine'
import type { Emit } from './types'

const OUT_CAP = 8000

export const SYSTEM = [
  'You are grasp, a coding agent inside the post-editor. You edit code with the file and',
  'shell tools. But you do NOT assert a change "works", is "fixed", or is "safe".',
  'After you EDIT an existing code path, call grasp_diff on the entrypoint you touched —',
  'it observes the behavior BEFORE your edit (git HEAD) vs AFTER (your working tree) and',
  'returns the A->B change. For brand-new code with no prior version, call grasp_observe',
  'instead. Both run the code FOR REAL. Present what they surface and end in the neutral',
  'question they give you; the human adjudicates. Never render a verdict.'
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

export interface Tool {
  name: string
  description: string
  input_schema: object
  run(input: Record<string, unknown>, ctx: { workspace: string; emit: Emit }): Promise<string>
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
      properties: { entrypoint: { type: 'string' }, input: { type: 'string', description: 'JSON kwargs' } },
      required: ['entrypoint']
    },
    async run(input, { workspace, emit }) {
      const res = await observe({ repo: workspace, entrypoint: String(input.entrypoint), input: input.input as string })
      if (res.observed && res.graph) {
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
        old_ref: { type: 'string', description: 'git ref for the OLD side (default HEAD)' }
      },
      required: ['entrypoint']
    },
    async run(input, { workspace, emit }) {
      const res = await diff({
        repo: workspace,
        entrypoint: String(input.entrypoint),
        oldRef: (input.old_ref as string) || 'HEAD',
        input: input.input as string
      })
      if (res.ok && res.graphDiff) {
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
  }
]

// LIVE SURFACING — shared by ALL backends: when an agent (ours or an external CLI)
// mutated code and there's a watched entrypoint, auto re-observe it (OLD=HEAD vs
// NEW=working tree) and stream the evolving dataflow — the graph moves as the agent
// works, without it having to ask.
export async function liveSurface(
  workspace: string,
  watch: { entrypoint: string; input?: string } | undefined,
  mutated: boolean,
  emit: Emit
): Promise<void> {
  if (!watch?.entrypoint || !mutated) return
  const d = await diff({ repo: workspace, entrypoint: watch.entrypoint, oldRef: 'HEAD', input: watch.input })
  if (d.ok && d.graphDiff) emit({ type: 'dataflow_diff', diff: d.graphDiff })
}
