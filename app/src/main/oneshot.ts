// One-shot (non-streaming) model calls for UI affordances that don't run the agent
// loop: context compaction (summarize the transcript) and prompt-enhance (rewrite the
// composer text). Reuses the active backend's wire + key so it works with whatever the
// user has configured. Deliberately tiny — no tools, no streaming, no trajectory.
import { getKey } from './vault'
import { PROVIDERS } from './backends/providers'

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
      const res = await fetch(`${cfg.base}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }], stream: false })
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
      const j = (await res.json()) as { content?: { type: string; text?: string }[] }
      const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      return { ok: true, text }
    }
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }], stream: false })
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return { ok: true, text: j.choices?.[0]?.message?.content ?? '' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
