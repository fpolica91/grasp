// The model client. grasp is provider-agnostic (Anthropic Messages format); it points
// at any compatible endpoint. Defaults to z.ai's GLM. The API key comes from the
// environment — never committed.
import type { ChatMessage, ChatResult } from '../shared/types'

const BASE = process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic'
const MODEL = process.env.GRASP_MODEL ?? 'glm-4.6'
const KEY = process.env.GRASP_API_KEY ?? ''

const SYSTEM =
  'You are grasp, an agentic coding assistant inside the post-editor. When you change ' +
  'code, you do not assert it "works" — you surface what the change observably does to ' +
  'the data and end in a neutral question for the human to adjudicate.'

export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  if (!KEY) return { ok: false, text: '', error: 'No model key. Set GRASP_API_KEY.' }
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: SYSTEM, messages })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, text: '', error: `model HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
    return { ok: true, text }
  } catch (e) {
    return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) }
  }
}
