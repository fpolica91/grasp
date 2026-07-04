// GLM backend — grasp's own tool-use loop on GLM's Anthropic Messages wire
// (GLM natively speaks Anthropic Messages + tool_use — verified). Owned code,
// no external agent binary.
import { getKey } from '../vault'
import {
  MUTATING_TOOLS,
  PLAN_SYSTEM,
  PLAN_TOOL_NAMES,
  SUBAGENT_SYSTEM,
  SUBAGENT_TOOLS,
  SYSTEM,
  TOOLS,
  liveSurface
} from './tools'
import type { SubagentRunner, Tool } from './tools'
import { requestApproval } from '../approvals'
import type { AgentBackend, BackendTurn, Emit } from './types'

const BASE = process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic'
const DEFAULT_MODEL = process.env.GRASP_MODEL ?? 'glm-5.2'
const MAX_STEPS = 16

type AnyBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; [k: string]: unknown }

async function callModel(
  model: string,
  messages: unknown[],
  system: string,
  tools: Tool[]
): Promise<{ ok: boolean; content?: AnyBlock[]; stop?: string; error?: string; usage?: { input: number; output: number } }> {
  const KEY = getKey()
  if (!KEY) return { ok: false, error: 'No model key. Add it in grasp (top-right).' }
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages
      })
    })
    if (!res.ok) return { ok: false, error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = (await res.json()) as {
      content?: AnyBlock[]
      stop_reason?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    return {
      ok: true,
      content: data.content ?? [],
      stop: data.stop_reason,
      usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }> {
  const workspace = turn.workspace
  const model = turn.model || DEFAULT_MODEL
  const plan = turn.mode === 'plan'
  const messages: unknown[] = [...turn.history, { role: 'user', content: turn.prompt }]

  // A depth-1 subagent: its own focused loop over the non-task tools; every event it
  // emits is tagged with the parent task id so the UI nests it under the task chip.
  const subagent: SubagentRunner = async (prompt, parentId) => {
    const subEmit: Emit = (e) => emit({ ...e, parent: parentId })
    const subMessages: unknown[] = [{ role: 'user', content: prompt }]
    let finalText = ''
    for (let s = 0; s < 10; s++) {
      const sr = await callModel(model, subMessages, SUBAGENT_SYSTEM, SUBAGENT_TOOLS)
      if (!sr.ok) return `subagent error: ${sr.error}`
      const blocks = sr.content ?? []
      subMessages.push({ role: 'assistant', content: blocks })
      for (const b of blocks) if (b.type === 'text' && b.text) { finalText = b.text; subEmit({ type: 'text', text: b.text }) }
      const subUses = blocks.filter((b) => b.type === 'tool_use')
      if (sr.stop !== 'tool_use' || subUses.length === 0) return finalText || '(subagent done)'
      const subResults: unknown[] = []
      for (const tu of subUses) {
        const tool = SUBAGENT_TOOLS.find((t) => t.name === tu.name)
        subEmit({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
        let out = ''
        try {
          out = tool ? await tool.run(tu.input ?? {}, { workspace, emit: subEmit, toolId: tu.id }) : `unknown tool: ${tu.name}`
        } catch (e) {
          out = `tool error: ${e instanceof Error ? e.message : String(e)}`
        }
        subEmit({ type: 'tool_result', id: tu.id, name: tu.name, summary: out.split('\n')[0].slice(0, 120) })
        subResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out })
      }
      subMessages.push({ role: 'user', content: subResults })
    }
    return finalText || '(subagent reached step limit)'
  }

  let turnTokens = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await callModel(model, messages, plan ? PLAN_SYSTEM : SYSTEM, plan ? TOOLS.filter((t) => PLAN_TOOL_NAMES.has(t.name)) : TOOLS)
    if (!r.ok) {
      emit({ type: 'error', error: r.error })
      return { messages }
    }
    if (r.usage) {
      emit({ type: 'usage', input: r.usage.input, output: r.usage.output })
      turnTokens += r.usage.input + r.usage.output
      if (turn.budget && turnTokens > turn.budget) {
        emit({ type: 'done', note: `stopped: reached the ${turn.budget.toLocaleString()}-token turn budget (used ${turnTokens.toLocaleString()}).` })
        return { messages }
      }
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
      // ASK MODE: pause for approval before a tool that changes the workspace.
      if (turn.mode === 'ask' && tu.name && MUTATING_TOOLS.has(tu.name)) {
        const ok = await requestApproval(emit, tu.name, tu.input ?? {})
        if (!ok) {
          output = 'skipped — you denied this action.'
          emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output })
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
          continue
        }
      }
      try {
        output = tool ? await tool.run(tu.input ?? {}, { workspace, emit, toolId: tu.id, subagent }) : `unknown tool: ${tu.name}`
      } catch (e) {
        output = `tool error: ${e instanceof Error ? e.message : String(e)}`
      }
      emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output.split('\n')[0].slice(0, 120), output: output.slice(0, 6000) })
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
    }

    await liveSurface(workspace, toolUses.some((t) => t.name === 'write_file' || t.name === 'run_bash'), emit)

    messages.push({ role: 'user', content: results })
  }
  emit({ type: 'done', note: 'reached step limit' })
  return { messages }
}

export const glmBackend: AgentBackend = {
  id: 'glm',
  label: 'GLM',
  // glm-5.2 / glm-5.1 are the premium (opus-tier) models; glm-4.6 stays the fast default.
  // Override the whole list with GRASP_GLM_MODELS if needed.
  models: (process.env.GRASP_GLM_MODELS ?? 'glm-5.2,glm-5.1,glm-4.6,glm-4.5-air').split(',').map((s) => s.trim()).filter(Boolean),
  available: () => (getKey() ? { ok: true } : { ok: false, reason: 'no GLM key in the vault' }),
  run
}
