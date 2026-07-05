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
  liveSurface,
  mcpAugmentedTools,
  withProjectContext
} from './tools'
import type { SubagentRunner, Tool } from './tools'
import { requestApproval } from '../approvals'
import { parseSSE } from './sse'
import type { AgentBackend, BackendTurn, Emit } from './types'

const BASE = process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic'
const DEFAULT_MODEL = process.env.GRASP_MODEL ?? 'glm-5.2'
const MAX_STEPS = 40

type AnyBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; [k: string]: unknown }

async function callModel(
  model: string,
  messages: unknown[],
  system: string,
  tools: Tool[],
  signal?: AbortSignal,
  onText?: (delta: string) => void
): Promise<{ ok: boolean; content?: AnyBlock[]; stop?: string; error?: string; usage?: { input: number; output: number } }> {
  const KEY = getKey()
  if (!KEY) return { ok: false, error: 'No model key. Add it in grasp (top-right).' }
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      signal,
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages,
        stream: true
      })
    })
    if (!res.ok) return { ok: false, error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    if (!res.body) return { ok: false, error: 'model returned no stream body' }
    // SSE reassembly: rebuild the content blocks (text + tool_use) from the streaming events
    // so the loop's tool handling is identical to the non-streaming path. text deltas are
    // forwarded live via onText so the UI renders the answer as it is written.
    const blocks: AnyBlock[] = []
    let cur: { type: string; text: string; id?: string; name?: string; json: string } | null = null
    let stopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    await parseSSE(res.body, (ev) => {
      const t = ev.type as string
      if (t === 'message_start') {
        inputTokens = ((ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage?.input_tokens) ?? 0
      } else if (t === 'content_block_start') {
        const cb = ev.content_block as { type: string; text?: string; id?: string; name?: string }
        cur = { type: cb.type, text: cb.text ?? '', id: cb.id, name: cb.name, json: '' }
      } else if (t === 'content_block_delta' && cur) {
        const d = ev.delta as { type: string; text?: string; partial_json?: string }
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          cur.text += d.text
          if (onText) onText(d.text)
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          cur.json += d.partial_json
        }
      } else if (t === 'content_block_stop' && cur) {
        if (cur.type === 'text') {
          blocks.push({ type: 'text', text: cur.text })
        } else if (cur.type === 'tool_use') {
          let input: Record<string, unknown> = {}
          try {
            input = cur.json ? JSON.parse(cur.json) : {}
          } catch {
            /* keep {} on a malformed tool-input stream */
          }
          blocks.push({ type: 'tool_use', id: cur.id, name: cur.name, input })
        }
        cur = null
      } else if (t === 'message_delta') {
        const delta = ev.delta as { stop_reason?: string } | undefined
        const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
        if (delta?.stop_reason) stopReason = delta.stop_reason
        // GLM (unlike the Anthropic spec) sends the REAL input_tokens here in message_delta;
        // message_start.usage is a zero placeholder. Capture both tokens from this event.
        if (usage?.input_tokens) inputTokens = usage.input_tokens
        if (usage?.output_tokens) outputTokens = usage.output_tokens
      }
    })
    return { ok: true, content: blocks, stop: stopReason, usage: { input: inputTokens, output: outputTokens } }
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'aborted' }
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
      const sr = await callModel(model, subMessages, withProjectContext(workspace, SUBAGENT_SYSTEM), SUBAGENT_TOOLS)
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
  let fuzzNudged = false // remind once per turn to surface the differential fuzz after an edit
  for (let step = 0; step < MAX_STEPS; step++) {
    if (turn.signal?.aborted) {
      emit({ type: 'done', note: 'stopped by you' })
      return { messages }
    }
    const tools = plan ? TOOLS.filter((t) => PLAN_TOOL_NAMES.has(t.name)) : await mcpAugmentedTools(workspace)
    const r = await callModel(
      model,
      messages,
      withProjectContext(workspace, plan ? PLAN_SYSTEM : SYSTEM),
      tools,
      turn.signal,
      // Stream text live (non-plan only — plan mode renders the final proposal as a card, so
      // its text is not streamed to avoid showing it twice).
      plan ? undefined : (d) => emit({ type: 'text_delta', text: d })
    )
    if (!r.ok) {
      if (turn.signal?.aborted) {
        emit({ type: 'done', note: 'stopped by you' })
        return { messages }
      }
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

    if (plan) {
      // plan mode doesn't stream — emit intermediate reasoning as full text bubbles.
      for (const b of textBlocks) emit({ type: 'text', text: b.text })
    } else {
      emit({ type: 'text_end' }) // finalize the streaming bubble (deltas were shown live)
    }
    if (terminal) {
      emit({ type: 'done' })
      return { messages }
    }

    const results: unknown[] = []
    for (const tu of toolUses) {
      const tool = tools.find((t) => t.name === tu.name)
      emit({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      let output = ''
      // ASK MODE: pause for approval before a workspace mutation OR an untrusted MCP tool
      // (external servers configured in .grasp/mcp.json — not built-ins).
      const isMcpTool = !TOOLS.find((t) => t.name === tu.name) && !!tools.find((t) => t.name === tu.name)
      if (turn.mode === 'ask' && tu.name && (MUTATING_TOOLS.has(tu.name) || isMcpTool)) {
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

    // An edit is not SHOWN until its behavioral consequence is surfaced. If this step
    // changed code but ran no differential surface, nudge the agent (once) to fuzz-diff it —
    // a bug that only breaks inputs it didn't try otherwise reads as "same flow".
    const mutatedNow = toolUses.some((t) => t.name && MUTATING_TOOLS.has(t.name))
    const diffedNow = toolUses.some((t) => t.name === 'grasp_fuzz_diff' || t.name === 'grasp_flow_diff')
    if (mutatedNow && !diffedNow && !fuzzNudged && results.length > 0) {
      fuzzNudged = true
      const last = results[results.length - 1] as { content: string }
      last.content +=
        '\n\n<system-reminder>You changed code. It is not shown until you surface its behavioral consequence. Before concluding, run grasp_fuzz_diff on the changed entrypoint across a SPREAD of inputs (valid, boundary, malformed, missing, wrong-type) so any input where old vs new diverge is revealed — a bug that only breaks inputs you did not try otherwise reads as "same flow". See the fuzz-diff skill. Do not claim the change works.</system-reminder>'
    }

    if (turn.flowAuto !== false)
      await liveSurface(workspace, mutatedNow, emit)

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
