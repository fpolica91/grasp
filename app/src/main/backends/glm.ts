// GLM backend — grasp's own tool-use loop on GLM's Anthropic Messages wire
// (GLM natively speaks Anthropic Messages + tool_use — verified). Owned code,
// no external agent binary.
import { getKey } from '../vault'
import { PLAN_SYSTEM, PLAN_TOOL_NAMES, SYSTEM, TOOLS, liveSurface } from './tools'
import type { AgentBackend, BackendTurn, Emit } from './types'

const BASE = process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic'
const DEFAULT_MODEL = process.env.GRASP_MODEL ?? 'glm-4.6'
const MAX_STEPS = 16

type AnyBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; [k: string]: unknown }

async function callModel(
  model: string,
  messages: unknown[],
  plan: boolean
): Promise<{ ok: boolean; content?: AnyBlock[]; stop?: string; error?: string }> {
  const KEY = getKey()
  if (!KEY) return { ok: false, error: 'No model key. Add it in grasp (top-right).' }
  const tools = plan ? TOOLS.filter((t) => PLAN_TOOL_NAMES.has(t.name)) : TOOLS
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: plan ? PLAN_SYSTEM : SYSTEM,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
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

async function run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }> {
  const workspace = turn.workspace
  const model = turn.model || DEFAULT_MODEL
  const plan = turn.mode === 'plan'
  const messages: unknown[] = [...turn.history, { role: 'user', content: turn.prompt }]

  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await callModel(model, messages, plan)
    if (!r.ok) {
      emit({ type: 'error', error: r.error })
      return { messages }
    }
    const blocks = r.content ?? []
    messages.push({ role: 'assistant', content: blocks })

    const toolUses = blocks.filter((b) => b.type === 'tool_use')
    const terminal = r.stop !== 'tool_use' || toolUses.length === 0
    const textBlocks = blocks.filter((b) => b.type === 'text' && b.text)

    // In plan mode the FINAL message is the proposal — render it as a plan card, not a
    // duplicate chat bubble. Intermediate reasoning (accompanying tool calls) still shows.
    if (plan && terminal) {
      const planText = textBlocks.map((b) => b.text).join('\n\n')
      emit(planText ? { type: 'plan', text: planText } : { type: 'text', text: '(no plan produced)' })
      emit({ type: 'done' })
      return { messages }
    }

    for (const b of textBlocks) emit({ type: 'text', text: b.text })
    if (terminal) {
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

    await liveSurface(
      workspace,
      turn.watch,
      toolUses.some((t) => t.name === 'write_file' || t.name === 'run_bash'),
      emit
    )

    messages.push({ role: 'user', content: results })
  }
  emit({ type: 'done', note: 'reached step limit' })
  return { messages }
}

export const glmBackend: AgentBackend = {
  id: 'glm',
  label: 'GLM',
  models: [DEFAULT_MODEL, 'glm-4.5-air'],
  available: () => (getKey() ? { ok: true } : { ok: false, reason: 'no GLM key in the vault' }),
  run
}
