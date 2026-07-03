// OpenAI backend — grasp's own tool-use loop on the OpenAI chat-completions wire.
// Works against api.openai.com or ANY OpenAI-compatible endpoint (GRASP_OPENAI_BASE);
// GLM's /api/coding/paas/v4 speaks this wire, which is how the seam is provable
// without an OpenAI key. Same tools, same events, same live surfacing as GLM.
import { getKey } from '../vault'
import { SYSTEM, TOOLS, liveSurface } from './tools'
import type { AgentBackend, BackendTurn, Emit } from './types'

const BASE = process.env.GRASP_OPENAI_BASE ?? 'https://api.openai.com/v1'
const MODELS = (process.env.GRASP_OPENAI_MODELS ?? 'gpt-5.2,gpt-5.1,gpt-4.1').split(',').map((s) => s.trim()).filter(Boolean)
const MAX_STEPS = 16

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Msg = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }

async function callModel(model: string, messages: Msg[]): Promise<{ ok: boolean; msg?: Msg; finish?: string; error?: string }> {
  const KEY = getKey('openai')
  if (!KEY) return { ok: false, error: 'No OpenAI key. Add one in grasp (or set GRASP_OPENAI_KEY).' }
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'system', content: SYSTEM }, ...messages],
        tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      })
    })
    if (!res.ok) return { ok: false, error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = (await res.json()) as { choices?: { message?: Msg; finish_reason?: string }[] }
    const choice = data.choices?.[0]
    if (!choice?.message) return { ok: false, error: 'model returned no choices' }
    return { ok: true, msg: choice.message, finish: choice.finish_reason }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }> {
  const workspace = turn.workspace
  const model = turn.model || MODELS[0]
  const messages: Msg[] = [...(turn.history as Msg[]), { role: 'user', content: turn.prompt }]

  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await callModel(model, messages)
    if (!r.ok || !r.msg) {
      emit({ type: 'error', error: r.error })
      return { messages }
    }
    messages.push(r.msg)
    if (r.msg.content) emit({ type: 'text', text: r.msg.content })

    const calls = r.msg.tool_calls ?? []
    if (r.finish !== 'tool_calls' || calls.length === 0) {
      emit({ type: 'done' })
      return { messages }
    }

    let mutated = false
    for (const tc of calls) {
      const name = tc.function.name
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments || '{}')
      } catch {
        /* malformed arguments -> run the tool with {} and let it report */
      }
      const tool = TOOLS.find((t) => t.name === name)
      emit({ type: 'tool_use', id: tc.id, name, input })
      let output = ''
      try {
        output = tool ? await tool.run(input, { workspace, emit }) : `unknown tool: ${name}`
      } catch (e) {
        output = `tool error: ${e instanceof Error ? e.message : String(e)}`
      }
      emit({ type: 'tool_result', id: tc.id, name, summary: output.split('\n')[0].slice(0, 120) })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: output })
      if (name === 'write_file' || name === 'run_bash') mutated = true
    }

    await liveSurface(workspace, turn.watch, mutated, emit)
  }
  emit({ type: 'done', note: 'reached step limit' })
  return { messages }
}

export const openaiBackend: AgentBackend = {
  id: 'openai',
  label: 'OpenAI',
  models: MODELS,
  available: () => (getKey('openai') ? { ok: true } : { ok: false, reason: 'no OpenAI key (set one, or GRASP_OPENAI_KEY)' }),
  run
}
