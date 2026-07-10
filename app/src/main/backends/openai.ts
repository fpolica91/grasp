// OpenAI backend — grasp's own tool-use loop on the OpenAI chat-completions wire.
// Works against api.openai.com or ANY OpenAI-compatible endpoint (GRASP_OPENAI_BASE);
// GLM's /api/coding/paas/v4 speaks this wire, which is how the seam is provable
// without an OpenAI key. Same tools, same events, same live surfacing as GLM.
import { getKey } from '../vault'
import {
  MUTATING_TOOLS,
  EDIT_TOOLS,
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
import { applyPathOps, shapingFor, type ThoughtLevel } from '../../shared/catalog'
import { preToolUseGate, fireHooks, summarizeHookOutputs } from '../hooks'

const BASE = process.env.GRASP_OPENAI_BASE ?? 'https://api.openai.com/v1'
const MODELS = (process.env.GRASP_OPENAI_MODELS ?? 'gpt-5.2,gpt-5.1,gpt-4.1').split(',').map((s) => s.trim()).filter(Boolean)

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Msg = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }

async function callModel(
  model: string,
  thoughtLevel: ThoughtLevel | undefined,
  messages: Msg[],
  system: string,
  tools: Tool[],
  signal?: AbortSignal,
  onText?: (delta: string) => void
): Promise<{ ok: boolean; msg?: Msg; finish?: string; error?: string; usage?: { input: number; output: number } }> {
  const KEY = getKey('openai')
  if (!KEY) return { ok: false, error: 'No OpenAI key. Add one in grasp (or set GRASP_OPENAI_KEY).' }
  try {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages: [{ role: 'system', content: system }, ...messages],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      stream: true,
      stream_options: { include_usage: true }
    }
    // Apply reasoning/thought-level shaping (openai wire: reasoning.effort).
    applyPathOps(body, shapingFor('openai', model, thoughtLevel))
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return { ok: false, error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    if (!res.body) return { ok: false, error: 'model returned no stream body' }
    // Reassemble the OpenAI delta stream into one assistant Msg (content + tool_calls) so the
    // loop is identical to the non-streaming path. text deltas are forwarded live via onText.
    let content = ''
    const tcAcc: Record<number, { id: string; name: string; arguments: string }> = {}
    let finishReason: string | undefined
    let promptTokens = 0
    let completionTokens = 0
    await parseSSE(res.body, (ev) => {
      const usage = ev.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
      if (usage) {
        promptTokens = usage.prompt_tokens ?? promptTokens
        completionTokens = usage.completion_tokens ?? completionTokens
      }
      const choice = (
        ev.choices as
          | {
              delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }
              finish_reason?: string
            }[]
          | undefined
      )?.[0]
      if (!choice) return
      const d = choice.delta
      if (d?.content) {
        content += d.content
        if (onText) onText(d.content)
      }
      if (Array.isArray(d?.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0
          if (!tcAcc[idx]) tcAcc[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
          if (tc.id) tcAcc[idx].id = tc.id
          if (tc.function?.name) tcAcc[idx].name = tc.function.name
          if (tc.function?.arguments) tcAcc[idx].arguments += tc.function.arguments
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    })
    const tool_calls: ToolCall[] = Object.keys(tcAcc)
      .map((k) => Number(k))
      .sort((a, b) => a - b)
      .map((idx) => ({ id: tcAcc[idx].id, function: { name: tcAcc[idx].name, arguments: tcAcc[idx].arguments } }))
      .filter((tc) => tc.function.name)
    const msg: Msg = { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }
    return { ok: true, msg, finish: finishReason, usage: { input: promptTokens, output: completionTokens } }
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'aborted' }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }> {
  const workspace = turn.workspace
  const model = turn.model || MODELS[0]
  const plan = turn.mode === 'plan'
  const messages: Msg[] = [...(turn.history as Msg[]), { role: 'user', content: turn.prompt }]

  const subagent: SubagentRunner = async (prompt, parentId, opts) => {
    const subEmit: Emit = (e) => emit({ ...e, parent: parentId })
    const sys = opts?.system ?? SUBAGENT_SYSTEM
    const subTools = opts?.tools ?? SUBAGENT_TOOLS
    const sub: Msg[] = [{ role: 'user', content: prompt }]
    let finalText = ''
    for (let s = 0; ; s++) {
      const sr = await callModel(model, turn.thoughtLevel, sub, withProjectContext(workspace, sys), subTools)
      if (!sr.ok || !sr.msg) return `subagent error: ${sr.error}`
      sub.push(sr.msg)
      if (sr.msg.content) { finalText = sr.msg.content; subEmit({ type: 'text', text: sr.msg.content }) }
      const calls = sr.msg.tool_calls ?? []
      if (sr.finish !== 'tool_calls' || calls.length === 0) return finalText || '(subagent done)'
      for (const tc of calls) {
        let inp: Record<string, unknown> = {}
        try {
          inp = JSON.parse(tc.function.arguments || '{}')
        } catch {
          /* ignore */
        }
        const tool = subTools.find((t) => t.name === tc.function.name)
        subEmit({ type: 'tool_use', id: tc.id, name: tc.function.name, input: inp })
        let out = ''
        try {
          out = tool ? await tool.run(inp, { workspace, emit: subEmit, toolId: tc.id }) : `unknown tool: ${tc.function.name}`
        } catch (e) {
          out = `tool error: ${e instanceof Error ? e.message : String(e)}`
        }
        subEmit({ type: 'tool_result', id: tc.id, name: tc.function.name, summary: out.split('\n')[0].slice(0, 120) })
        sub.push({ role: 'tool', tool_call_id: tc.id, content: out })
      }
    }
    return finalText || '(subagent ended without a final message)'
  }

  let turnTokens = 0
  let fuzzNudged = false
  for (let step = 0; ; step++) {
    if (turn.signal?.aborted) {
      emit({ type: 'done', note: 'stopped by you' })
      return { messages }
    }
    const steerText = turn.steer?.()
    if (steerText) messages.push({ role: 'user', content: steerText })
    const tools = plan ? TOOLS.filter((t) => PLAN_TOOL_NAMES.has(t.name)) : await mcpAugmentedTools(workspace)
    const r = await callModel(
      model,
      turn.thoughtLevel,
      messages,
      withProjectContext(workspace, plan ? PLAN_SYSTEM : SYSTEM),
      tools,
      turn.signal,
      plan ? undefined : (d) => emit({ type: 'text_delta', text: d })
    )
    if (!r.ok || !r.msg) {
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
    messages.push(r.msg)
    const calls = r.msg.tool_calls ?? []
    const terminal = r.finish !== 'tool_calls' || calls.length === 0

    // In plan mode the final message is the proposal — a plan card, not a bubble.
    if (plan && terminal) {
      if (r.msg.content) emit({ type: 'plan', text: r.msg.content })
      emit({ type: 'done' })
      return { messages }
    }
    if (plan) {
      if (r.msg.content) emit({ type: 'text', text: r.msg.content })
    } else {
      emit({ type: 'text_end' })
    }
    if (terminal) {
      emit({ type: 'done' })
      return { messages }
    }

    let mutated = false
    let diffed = false
    for (const tc of calls) {
      const name = tc.function.name
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments || '{}')
      } catch {
        /* malformed arguments -> run the tool with {} and let it report */
      }
      const tool = tools.find((t) => t.name === name)
      emit({ type: 'tool_use', id: tc.id, name, input })
      let output = ''
      if (plan) {
        // read-only tools only; a mutating call in plan mode is refused honestly
        if (MUTATING_TOOLS.has(name)) output = 'plan mode: cannot edit; propose it in the plan.'
      }
      // Ask mode also gates untrusted MCP tools (external servers — not built-ins).
      const isMcpTool = !TOOLS.find((t) => t.name === name) && !!tools.find((t) => t.name === name)
      if (!output && turn.mode === 'ask' && (MUTATING_TOOLS.has(name) || isMcpTool)) {
        const ok = await requestApproval(emit, name, input)
        if (!ok) output = 'skipped — you denied this action.'
      }
      // Lifecycle hook: PreToolUse — final pre-execution authority; may BLOCK the tool.
      const gate = preToolUseGate(workspace, name, input)
      if (gate.blocked) output = `blocked by hook: ${gate.reason}`
      if (!output) {
        try {
          output = tool ? await tool.run(input, { workspace, emit, toolId: tc.id, subagent }) : `unknown tool: ${name}`
        } catch (e) {
          output = `tool error: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      emit({ type: 'tool_result', id: tc.id, name, summary: output.split('\n')[0].slice(0, 120), output: output.slice(0, 6000) })
      // Lifecycle hook: PostToolUse — surface output (e.g. a linter run).
      const postOut = summarizeHookOutputs(fireHooks({ workspace, event: 'PostToolUse', tool: name, input }))
      if (postOut) emit({ type: 'hook', event: 'PostToolUse', tool: name, output: postOut })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: output })
      if (EDIT_TOOLS.has(name) && !output.startsWith('skipped') && !output.startsWith('plan mode')) mutated = true
      if (name === 'grasp_fuzz_diff' || name === 'grasp_flow_diff') diffed = true
    }

    if (mutated && !diffed && !fuzzNudged) {
      fuzzNudged = true
      const last = messages[messages.length - 1] as { role: string; content: string }
      if (last && last.role === 'tool')
        last.content +=
          '\n\n<system-reminder>You changed code. Before concluding, run grasp_fuzz_diff on the changed entrypoint across a spread of inputs (valid, boundary, malformed, missing, wrong-type) to reveal any input where old vs new diverge — a bug that only breaks inputs you did not try reads as "same flow". See the fuzz-diff skill. Do not claim the change works.</system-reminder>'
    }
    if (turn.flowAuto !== false) await liveSurface(workspace, mutated, emit)
  }
}

export const openaiBackend: AgentBackend = {
  id: 'openai',
  label: 'OpenAI',
  models: MODELS,
  available: () => (getKey('openai') ? { ok: true } : { ok: false, reason: 'no OpenAI key (set one, or GRASP_OPENAI_KEY)' }),
  run
}
