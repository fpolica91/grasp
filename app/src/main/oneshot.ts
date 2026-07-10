// One-shot (non-streaming) model calls for UI affordances that don't run the agent
// loop: context compaction (summarize the transcript) and prompt-enhance (rewrite the
// composer text). Reuses the active backend's wire + key so it works with whatever the
// user has configured. Deliberately tiny — no tools, no streaming, no trajectory.
import { getKey } from './vault'
import { PROVIDERS } from './backends/providers'
import { parseSSE } from './backends/sse'

type Wire = 'anthropic' | 'openai'
interface BackendCfg {
  wire: Wire
  base: string
  key: string
  defaultModel: string
}

function cfgFor(backend: string): BackendCfg {
  // Layer B providers: anthropic wire, per-provider base + vault key (the provider id).
  const p = PROVIDERS.find((x) => x.id === backend)
  if (p) return { wire: 'anthropic', base: p.base, key: p.id, defaultModel: p.defaultModel }
  switch (backend) {
    case 'openai':
      return { wire: 'openai', base: process.env.GRASP_OPENAI_BASE ?? 'https://api.openai.com/v1', key: 'openai', defaultModel: 'gpt-5.2' }
    case 'claude':
    case 'claude-code': // the CLI backend — route one-shot calls to the Claude API
      return { wire: 'anthropic', base: 'https://api.anthropic.com', key: 'anthropic', defaultModel: 'claude-haiku-4-5-20251001' }
    default: // glm
      return { wire: 'anthropic', base: process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic', key: 'glm', defaultModel: 'glm-4.6' }
  }
}

export interface OneShotOpts {
  backend: string
  model?: string
  system: string
  user: string
  maxTokens?: number
}

export async function oneShot(opts: OneShotOpts): Promise<{ ok: boolean; text?: string; error?: string }> {
  const cfg = cfgFor(opts.backend)
  const key = getKey(cfg.key)
  if (!key) return { ok: false, error: `no ${cfg.key} key — add one in Settings` }
  const model = opts.model || cfg.defaultModel
  const maxTokens = opts.maxTokens ?? 1024
  try {
    if (cfg.wire === 'anthropic') {
      // STREAM + reassemble — some Anthropic-compat endpoints (GLM) hang on stream:false.
      const res = await fetch(`${cfg.base}/v1/messages`, {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }], stream: true })
      })
      if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
      let text = ''
      await parseSSE(res.body, (ev) => {
        const delta = (ev as { delta?: { text?: string } }).delta
        if (delta?.text) text += delta.text
      })
      return { ok: true, text }
    }
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }], stream: true })
    })
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
    let text = ''
    await parseSSE(res.body, (ev) => {
      const choice = (ev as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
      if (choice?.delta?.content) text += choice.delta.content
    })
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
