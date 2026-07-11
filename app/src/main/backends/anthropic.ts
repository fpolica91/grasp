// Shared Anthropic Messages backend factory. Both GLM (api.z.ai, which natively
// speaks the Anthropic Messages + tool_use wire) and Claude (api.anthropic.com)
// are the SAME protocol — one loop, parameterized by base URL, default model, and
// which vault key to read. Owned code, no external agent binary.
//
// This is the load-bearing agent loop: it carries the moat (SYSTEM prompt, the
// ask-mode approval gate, the post-edit fuzz nudge, liveSurface re-observation)
// and emits the model-trajectory inspector records. Identical behavior across
// every Anthropic-wire provider.
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
import { decidePermission } from '../permissions'
import { parseSSE } from './sse'
import type { AgentBackend, BackendTurn, Emit } from './types'
import { applyPathOps, shapingFor, type ThoughtLevel } from '../../shared/catalog'
import { preToolUseGate, fireHooks, summarizeHookOutputs } from '../hooks'


type AnyBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; [k: string]: unknown }

export interface AnthropicBackendOpts {
  id: string
  label: string
  base: string // e.g. https://api.anthropic.com or https://api.z.ai/api/anthropic
  defaultModel: string
  models: string[]
  keyProvider?: string // vault provider name (default 'glm' for back-compat)
  keyEnvNote?: string // human hint shown when the key is missing
  extraHeaders?: Record<string, string> // e.g. anthropic-beta
  extraBody?: Record<string, unknown> // merged into the request body (e.g. { thinking: {...} })
  maxTokens?: number
}

export function makeAnthropicBackend(o: AnthropicBackendOpts): AgentBackend {
  const keyProvider = o.keyProvider ?? 'glm'
  const maxTokens = o.maxTokens ?? 4096

  async function callModel(
    model: string,
    thoughtLevel: ThoughtLevel | undefined,
    messages: unknown[],
    system: string,
    tools: Tool[],
    signal?: AbortSignal,
    onText?: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): Promise<{ ok: boolean; content?: AnyBlock[]; stop?: string; error?: string; usage?: { input: number; output: number } }> {
    const KEY = getKey(keyProvider)
    if (!KEY) return { ok: false, error: o.keyEnvNote ?? `No ${o.label} key. Add it in grasp (top-right).` }
    try {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages,
        stream: true,
        ...(o.extraBody ?? {})
      }
      // Apply reasoning/thought-level shaping (anthropic wire: thinking.budget_tokens;
      // a thinking level also bumps max_tokens above the budget, which the op does).
      applyPathOps(body, shapingFor(o.id, model, thoughtLevel))
      const res = await fetch(`${o.base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(o.extraHeaders ?? {}) },
        body: JSON.stringify(body)
      })
      if (!res.ok) return { ok: false, error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
      if (!res.body) return { ok: false, error: 'model returned no stream body' }
      const blocks: AnyBlock[] = []
      let cur: { type: string; text: string; id?: string; name?: string; json: string } | null = null
      let stopReason: string | undefined
      let inputTokens = 0
      let outputTokens = 0
      let thinkingStart = 0
      await parseSSE(res.body, (ev) => {
        const t = ev.type as string
        if (t === 'message_start') {
          inputTokens = ((ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage?.input_tokens) ?? 0
        } else if (t === 'content_block_start') {
          const cb = ev.content_block as { type: string; text?: string; id?: string; name?: string }
          cur = { type: cb.type, text: cb.text ?? '', id: cb.id, name: cb.name, json: '' }
          if (cb.type === 'thinking') thinkingStart = Date.now()
        } else if (t === 'content_block_delta' && cur) {
          const d = ev.delta as { type: string; text?: string; partial_json?: string; thinking?: string }
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            cur.text += d.text
            if (onText) onText(d.text)
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            cur.text += d.thinking
            if (onThinking) onThinking(d.thinking)
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            cur.json += d.partial_json
          }
        } else if (t === 'content_block_stop' && cur) {
          if (cur.type === 'text') {
            blocks.push({ type: 'text', text: cur.text })
          } else if (cur.type === 'thinking') {
            // thinking blocks are surfaced via events, not pushed to the content array
            if (onThinking && thinkingStart) void (Date.now() - thinkingStart)
          } else if (cur.type === 'tool_use') {
            let input: Record<string, unknown> = {}
            try { input = cur.json ? JSON.parse(cur.json) : {} } catch { /* keep {} */ }
            blocks.push({ type: 'tool_use', id: cur.id, name: cur.name, input })
          }
          cur = null
        } else if (t === 'message_delta') {
          const delta = ev.delta as { stop_reason?: string } | undefined
          const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
          if (delta?.stop_reason) stopReason = delta.stop_reason
          // GLM (unlike the Anthropic spec) sends the REAL input_tokens here in
          // message_delta; message_start.usage is a zero placeholder. Capturing both
          // here is harmless for real Anthropic (which sends them in message_start).
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

  // Stringify one message's content into the flat text the trajectory inspector renders.
  function messageToTrajectory(m: { role?: string; content?: unknown }): { role: 'system' | 'user' | 'assistant' | 'tool'; text: string } | null {
    const role = (m.role as string) ?? 'user'
    const c = m.content
    if (typeof c === 'string') {
      if (!c.trim()) return null
      return { role: role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user', text: c }
    }
    if (!Array.isArray(c)) return null
    let text = ''
    let isTool = false
    for (const b of c as { type?: string; text?: string; content?: string; name?: string; input?: unknown }[]) {
      const t = b.type
      if (t === 'text' && b.text) text += (text ? '\n' : '') + b.text
      else if (t === 'thinking' && b.text) text += (text ? '\n' : '') + b.text
      else if (t === 'tool_use') { isTool = true; text += (text ? '\n' : '') + `→ ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 200)})` }
      else if (t === 'tool_result') { isTool = true; const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''); text += (text ? '\n' : '') + body.slice(0, 4000) }
    }
    if (!text.trim()) return null
    return { role: isTool ? 'tool' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user', text }
  }

  async function run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }> {
    const workspace = turn.workspace
    const model = turn.model || o.defaultModel
    const plan = turn.mode === 'plan'
    const messages: unknown[] = [...turn.history, { role: 'user', content: turn.prompt }]

    const subagent: SubagentRunner = async (prompt, parentId, opts) => {
      const subEmit: Emit = (e) => emit({ ...e, parent: parentId })
      const sys = opts?.system ?? SUBAGENT_SYSTEM
      const subTools = opts?.tools ?? SUBAGENT_TOOLS
      const subMessages: unknown[] = [{ role: 'user', content: prompt }]
      let finalText = ''
      for (let s = 0; ; s++) {
        const sr = await callModel(model, turn.thoughtLevel, subMessages, withProjectContext(workspace, sys), subTools)
        if (!sr.ok) return `subagent error: ${sr.error}`
        const blocks = sr.content ?? []
        subMessages.push({ role: 'assistant', content: blocks })
        for (const b of blocks) if (b.type === 'text' && b.text) { finalText = b.text; subEmit({ type: 'text', text: b.text }) }
        const subUses = blocks.filter((b) => b.type === 'tool_use')
        if (sr.stop !== 'tool_use' || subUses.length === 0) return finalText || '(subagent done)'
        const subResults: unknown[] = []
        for (const tu of subUses) {
          const tool = subTools.find((t) => t.name === tu.name)
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
      return finalText || '(subagent ended without a final message)'
    }

    let turnTokens = 0
    let fuzzNudged = false
    let shownMessages = 0
    for (let step = 0; ; step++) {
      if (turn.signal?.aborted) {
        emit({ type: 'done', note: 'stopped by you' })
        return { messages }
      }
      const steerText = turn.steer?.()
      if (steerText) messages.push({ role: 'user', content: steerText })
      const tools = plan ? TOOLS.filter((t) => PLAN_TOOL_NAMES.has(t.name)) : await mcpAugmentedTools(workspace)
      const sysPrompt = withProjectContext(workspace, plan ? PLAN_SYSTEM : SYSTEM)
      const inputDelta = messages.slice(shownMessages)
      const callStart = Date.now()
      let reasoning = ''
      const r = await callModel(
        model,
        turn.thoughtLevel,
        messages,
        sysPrompt,
        tools,
        turn.signal,
        plan ? undefined : (d) => emit({ type: 'text_delta', text: d }),
        (d) => { reasoning += d; emit({ type: 'thinking_delta', text: d }) }
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

      const trajCall = {
        n: step + 1,
        model,
        source: 'Main session',
        ts: callStart,
        ms: Date.now() - callStart,
        inputTokens: r.usage?.input,
        outputTokens: r.usage?.output,
        input: (inputDelta as { role?: string; content?: unknown }[]).map(messageToTrajectory).filter(Boolean) as { role: 'system' | 'user' | 'assistant' | 'tool'; text: string }[],
        ...(step === 0 ? { system: sysPrompt } : {}),
        reasoning: reasoning || undefined,
        output: textBlocks.map((b) => b.text).join('\n\n') || undefined,
        toolCalls: toolUses.map((tu) => ({ id: String(tu.id), name: String(tu.name ?? ''), input: tu.input ?? {} })),
        toolResults: [] as { id: string; name: string; output: string }[]
      }

      if (plan && terminal) {
        const planText = textBlocks.map((b) => b.text).join('\n\n')
        emit(planText ? { type: 'plan', text: planText } : { type: 'text', text: '(no plan produced)' })
        emit({ type: 'trajectory_call', call: trajCall })
        emit({ type: 'done' })
        return { messages }
      }

      if (plan) {
        for (const b of textBlocks) emit({ type: 'text', text: b.text })
      } else {
        emit({ type: 'thinking_end' })
        emit({ type: 'text_end' })
      }
      if (terminal) {
        emit({ type: 'trajectory_call', call: trajCall })
        emit({ type: 'done' })
        return { messages }
      }

      const results: unknown[] = []
      for (const tu of toolUses) {
        if (turn.signal?.aborted) break // Stop ends the batch — no post-Stop tool tail
        const tool = tools.find((t) => t.name === tu.name)
        emit({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
        let output = ''
        // Lifecycle hook: PreToolUse — a hook may BLOCK the tool (deny).
        const gate = tu.name ? preToolUseGate(workspace, tu.name, tu.input ?? {}) : { blocked: false, reason: '' }
        if (gate.blocked) {
          output = `blocked by hook: ${gate.reason}`
          emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output })
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
          continue
        }
        const isMcpTool = !TOOLS.find((t) => t.name === tu.name) && !!tools.find((t) => t.name === tu.name)
        // Permission kernel — applies in EVERY mode. deny always blocks (teaches via the
        // rule); ask forces a prompt; allow skips the ask-gate; default → mode behavior.
        const perm = tu.name ? decidePermission(workspace, tu.name, tu.input ?? {}, isMcpTool) : { effect: 'default' as const, capability: 'Tool' as const, target: tu.name ?? '' }
        if (perm.effect === 'deny') {
          output = `denied by your ${perm.source} permission rule: ${perm.capability}(${perm.rule?.pattern}). Edit .grasp/permissions.json to change it.`
          emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output })
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
          continue
        }
        const mustAsk = perm.effect === 'ask' || (turn.mode === 'ask' && !!tu.name && (MUTATING_TOOLS.has(tu.name) || isMcpTool) && perm.effect !== 'allow')
        if (mustAsk) {
          const ok = await requestApproval(emit, tu.name ?? "", tu.input ?? {}, turn.signal, { capability: perm.capability, target: perm.target })
          if (!ok) {
            output = 'skipped — you denied this action.'
            emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output })
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
            continue
          }
        }
        try {
          output = tool ? await tool.run(tu.input ?? {}, { workspace, emit, toolId: tu.id, subagent, signal: turn.signal }) : `unknown tool: ${tu.name}`
        } catch (e) {
          output = `tool error: ${e instanceof Error ? e.message : String(e)}`
        }
        emit({ type: 'tool_result', id: tu.id, name: tu.name, summary: output.split('\n')[0].slice(0, 120), output: output.slice(0, 6000) })
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: output })
        // Lifecycle hook: PostToolUse — surface output (e.g. a linter run).
        const postOut = summarizeHookOutputs(fireHooks({ workspace, event: 'PostToolUse', tool: tu.name, input: tu.input }))
        if (postOut) emit({ type: 'hook', event: 'PostToolUse', tool: tu.name, output: postOut })
      }

      const mutatedNow = toolUses.some((t) => t.name && EDIT_TOOLS.has(t.name))
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
      trajCall.toolResults = results.map((rr) => {
        const r0 = rr as { tool_use_id: string; content: string }
        const tu = toolUses.find((t) => t.id === r0.tool_use_id)
        return { id: r0.tool_use_id, name: String(tu?.name ?? ''), output: String(r0.content ?? '') }
      })
      emit({ type: 'trajectory_call', call: trajCall })
      shownMessages = messages.length
    }
  }

  return {
    id: o.id,
    label: o.label,
    models: o.models,
    available: () => (getKey(keyProvider) ? { ok: true } : { ok: false, reason: o.keyEnvNote ?? `no ${o.label} key in the vault` }),
    run
  }
}
