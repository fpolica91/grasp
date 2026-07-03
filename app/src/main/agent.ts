// The agentic loop. grasp drives a real tool-use agent on GLM's Anthropic wire
// (GLM natively speaks Anthropic Messages + tool_use — verified). This is owned code,
// no external agent binary. The agent can read/write files and run commands, AND it
// has a first-class `grasp_observe` tool: after it changes code it surfaces the OBSERVED
// dataflow and ends in a neutral question — the post-editor loop, agent-native.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import { diff, observe } from './engine'
import { getKey } from './vault'

const BASE = process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic'
const MODEL = process.env.GRASP_MODEL ?? 'glm-4.6'
const MAX_STEPS = 16
const OUT_CAP = 8000

const SYSTEM = [
  'You are grasp, a coding agent inside the post-editor. You edit code with the file and',
  'shell tools. But you do NOT assert a change "works", is "fixed", or is "safe".',
  'After you EDIT an existing code path, call grasp_diff on the entrypoint you touched —',
  'it observes the behavior BEFORE your edit (git HEAD) vs AFTER (your working tree) and',
  'returns the A->B change. For brand-new code with no prior version, call grasp_observe',
  'instead. Both run the code FOR REAL. Present what they surface and end in the neutral',
  'question they give you; the human adjudicates. Never render a verdict.'
].join(' ')

type AnyBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; [k: string]: unknown }
type Emit = (event: Record<string, unknown>) => void

interface Tool {
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

const TOOLS: Tool[] = [
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
  }
]

async function callModel(messages: unknown[]): Promise<{ ok: boolean; content?: AnyBlock[]; stop?: string; error?: string }> {
  const KEY = getKey()
  if (!KEY) return { ok: false, error: 'No model key. Add it in grasp (top-right).' }
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM,
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages
      })
    })
    if (!res.ok) return { ok: false, error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = (await res.json()) as { content?: AnyBlock[]; stop_reason?: string }
    return { ok: true, content: data.content ?? [], stop: data.stop_reason }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function runAgent(
  sender: WebContents,
  params: { workspace: string; prompt: string; history: unknown[] }
): Promise<{ messages: unknown[] }> {
  const emit: Emit = (event) => {
    if (!sender.isDestroyed()) sender.send('agent:event', event)
  }
  const workspace = params.workspace || process.env.GRASP_WORKSPACE || process.cwd()
  const messages: unknown[] = [...params.history, { role: 'user', content: params.prompt }]

  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await callModel(messages)
    if (!r.ok) {
      emit({ type: 'error', error: r.error })
      return { messages }
    }
    const blocks = r.content ?? []
    messages.push({ role: 'assistant', content: blocks })

    for (const b of blocks) {
      if (b.type === 'text' && b.text) emit({ type: 'text', text: b.text })
    }

    const toolUses = blocks.filter((b) => b.type === 'tool_use')
    if (r.stop !== 'tool_use' || toolUses.length === 0) {
      emit({ type: 'done' })
      return { messages }
    }

    const results: unknown[] = []
    for (const tu of toolUses) {
      const tool = TOOLS.find((t) => t.name === tu.name)
      emit({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      let output = ''
      try {
        output = tool ? await tool.run(tu.input ?? {}, { workspace, emit }) : `unknown tool: ${tu.name}`
      } catch (e) {
        output = `tool error: ${e instanceof Error ? e.message : String(e)}`
      }
      emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output.split('\n')[0].slice(0, 120) })
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
    }
    messages.push({ role: 'user', content: results })
  }
  emit({ type: 'done', note: 'reached step limit' })
  return { messages }
}
