// The model catalog + reasoning/thought-level shaping.
//
// grasp used to drive models from env-var CSVs. This module adds the two things
// ZCode's catalog gave it: (1) per-model metadata (context window, max output,
// modalities) and (2) reasoning/thought-level control — an 8-step ladder in
// ZCode's UI; here a 5-step subset (off/low/medium/high/max) applied as JSON-path
// operations on the outbound request body, exactly ZCode's mechanism.
//
// The two wires grasp speaks map cleanly:
//   anthropic       → thinking = { type: 'enabled', budget_tokens } (extended thinking)
//   openai          → reasoning = { effort: 'minimal'|'low'|'medium'|'high' }
//
// CRITICAL Anthropic constraint: max_tokens MUST exceed budget_tokens. So every
// thinking level also bumps max_tokens (budget + a completion margin); the base
// body's max_tokens is overridden by the op. Without this the API 400s.

export type Wire = 'anthropic' | 'openai'

// The thought-level ladder. `undefined` (no choice) means "leave it to the
// provider default" — grasp applies NO shaping, preserving pre-catalog behavior.
export type ThoughtLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

export const THOUGHT_LEVELS: ThoughtLevel[] = ['off', 'low', 'medium', 'high', 'max']
export const THOUGHT_LABEL: Record<ThoughtLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
}

// A JSON path into the request body, and a set/unset operation on it.
export type Path = (string | number)[]
export interface PathSetOp {
  path: Path
  value: unknown
}
export interface LevelShaping {
  set?: PathSetOp[]
  unset?: Path[] // delete these paths (value-less)
}

export interface ReasoningConfig {
  default: ThoughtLevel
  levels: Partial<Record<ThoughtLevel, Partial<Record<Wire, LevelShaping>>>>
}

export interface ModelEntry {
  id: string
  backend: string // 'glm' | 'claude' | 'openai' | 'claude-code'
  wire: Wire
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: string[] // e.g. ['text','image']
  reasoning?: ReasoningConfig // absent ⇒ this model has no thought-level control
}

// ---- path-op engine -------------------------------------------------------

function deepSet(root: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return
  let cur: Record<string, unknown> = root
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    const next = cur[k]
    cur[k] = typeof next === 'object' && next !== null ? next : {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
}

function deepUnset(root: Record<string, unknown>, path: Path): void {
  if (path.length === 0) return
  let cur: Record<string, unknown> = root
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]]
    if (typeof next !== 'object' || next === null) return
    cur = next as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (Array.isArray(cur)) {
    const idx = typeof last === 'number' ? last : parseInt(String(last), 10)
    if (Number.isInteger(idx)) cur.splice(idx, 1)
  } else {
    delete cur[last]
  }
}

/** Apply a level's shaping to an outbound request body (mutates + returns it). */
export function applyPathOps(body: Record<string, unknown>, shaping: LevelShaping | undefined): Record<string, unknown> {
  if (!shaping) return body
  if (shaping.unset) for (const p of shaping.unset) deepUnset(body, p)
  if (shaping.set) for (const op of shaping.set) deepSet(body, op.path, op.value)
  return body
}

// ---- catalog --------------------------------------------------------------

// OpenAI-wire reasoning-effort levels (GPT-5 family). Non-reasoning models (e.g.
// gpt-4.1) simply omit a `reasoning` config so no shaping is applied.
const OPENAI_EFFORT: Partial<Record<ThoughtLevel, { 'openai': LevelShaping }>> = {
  off: { openai: { set: [{ path: ['reasoning'], value: { effort: 'minimal' } }] } },
  low: { openai: { set: [{ path: ['reasoning'], value: { effort: 'low' } }] } },
  medium: { openai: { set: [{ path: ['reasoning'], value: { effort: 'medium' } }] } },
  high: { openai: { set: [{ path: ['reasoning'], value: { effort: 'high' } }] } },
  max: { openai: { set: [{ path: ['reasoning'], value: { effort: 'high' } }] } } // OpenAI caps at 'high'
}

// budget_tokens / max_tokens per level (anthropic). Kept conservative; a model's
// own maxOutputTokens (if larger) is preferred at 'max'.
const BUDGET: Record<Exclude<ThoughtLevel, 'off'>, number> = { low: 2048, medium: 8192, high: 16000, max: 28000 }
const MARGIN = 4096

function anthropicLevels(): ReasoningConfig['levels'] {
  const out: Partial<Record<ThoughtLevel, { anthropic: LevelShaping }>> = {
    off: { anthropic: { set: [{ path: ['thinking'], value: { type: 'disabled' } }] } }
  }
  ;(['low', 'medium', 'high', 'max'] as const).forEach((lvl) => {
    out[lvl] = {
      anthropic: {
        set: [
          { path: ['thinking'], value: { type: 'enabled', budget_tokens: BUDGET[lvl] } },
          { path: ['max_tokens'], value: BUDGET[lvl] + MARGIN }
        ]
      }
    }
  })
  return out
}

export const CATALOG: ModelEntry[] = [
  // ---- GLM (api.z.ai, anthropic wire) ----
  { id: 'glm-5.2', backend: 'glm', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'glm-5.1', backend: 'glm', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'glm-4.6', backend: 'glm', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 8192, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'glm-4.5-air', backend: 'glm', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 4096, inputModalities: ['text', 'image'] },

  // ---- Claude (api.anthropic.com, anthropic wire) ----
  { id: 'claude-sonnet-5', backend: 'claude', wire: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'claude-opus-4-8', backend: 'claude', wire: 'anthropic', contextWindow: 200000, maxOutputTokens: 32000, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'claude-fable-5', backend: 'claude', wire: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'claude-haiku-4-5-20251001', backend: 'claude', wire: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },

  // ---- OpenAI (openai wire) ----
  { id: 'gpt-5.2', backend: 'openai', wire: 'openai', contextWindow: 272000, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'medium', levels: OPENAI_EFFORT as ReasoningConfig['levels'] } },
  { id: 'gpt-5.1', backend: 'openai', wire: 'openai', contextWindow: 272000, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'medium', levels: OPENAI_EFFORT as ReasoningConfig['levels'] } },
  { id: 'gpt-4.1', backend: 'openai', wire: 'openai', contextWindow: 1047576, maxOutputTokens: 32768, inputModalities: ['text', 'image'] }, // legacy, non-reasoning

  // ---- Layer B providers (anthropic wire) ---- reasoning models get the thinking ladder.
  { id: 'kimi-k2.6', backend: 'moonshot', wire: 'anthropic', contextWindow: 262144, maxOutputTokens: 98304, inputModalities: ['text', 'image', 'video'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'kimi-k2.5', backend: 'moonshot', wire: 'anthropic', contextWindow: 262144, maxOutputTokens: 98304, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'moonshot-v1-128k', backend: 'moonshot', wire: 'anthropic', contextWindow: 131072, inputModalities: ['text'] },
  { id: 'deepseek-v4-pro', backend: 'deepseek', wire: 'anthropic', contextWindow: 1000000, maxOutputTokens: 384000, inputModalities: ['text'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'deepseek-v4-flash', backend: 'deepseek', wire: 'anthropic', contextWindow: 1000000, maxOutputTokens: 65536, inputModalities: ['text'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'qwen3.5-plus', backend: 'qwen', wire: 'anthropic', contextWindow: 1000000, maxOutputTokens: 16384, inputModalities: ['text', 'image', 'video'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'qwen3.5-flash', backend: 'qwen', wire: 'anthropic', contextWindow: 1000000, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'qwen3-max', backend: 'qwen', wire: 'anthropic', contextWindow: 32768, inputModalities: ['text'] },
  { id: 'mimo-v2.5-pro', backend: 'xiaomi', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 16384, inputModalities: ['text', 'image', 'audio', 'video'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'mimo-v2.5', backend: 'xiaomi', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 16384, inputModalities: ['text', 'audio', 'video'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'mimo-v2-flash', backend: 'xiaomi', wire: 'anthropic', contextWindow: 131072, inputModalities: ['text'] },
  { id: 'MiniMax-M3', backend: 'minimax', wire: 'anthropic', contextWindow: 1000000, maxOutputTokens: 131072, inputModalities: ['text', 'image', 'video'] },
  { id: 'MiniMax-M2', backend: 'minimax', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 131072, inputModalities: ['text'] },
  { id: 'glm-5.1', backend: 'bigmodel', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'glm-5', backend: 'bigmodel', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 16384, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } },
  { id: 'glm-4.6', backend: 'bigmodel', wire: 'anthropic', contextWindow: 131072, maxOutputTokens: 8192, inputModalities: ['text', 'image'], reasoning: { default: 'off', levels: anthropicLevels() } }
]

// index by "<backend>:<id>" (precise) with a bare-id fallback
const INDEX: Map<string, ModelEntry> = (() => {
  const m = new Map<string, ModelEntry>()
  for (const e of CATALOG) {
    m.set(`${e.backend}:${e.id}`, e)
    if (!m.has(e.id)) m.set(e.id, e) // first backend wins the bare-id slot
  }
  return m
})()

export function lookupModel(backend: string | undefined, modelId: string): ModelEntry | undefined {
  if (backend) {
    const hit = INDEX.get(`${backend}:${modelId}`)
    if (hit) return hit
  }
  return INDEX.get(modelId)
}

/** Resolve the shaping for a (backend, model, level) on its wire. undefined ⇒ no-op. */
export function shapingFor(
  backend: string | undefined,
  modelId: string,
  level: ThoughtLevel | undefined
): LevelShaping | undefined {
  if (!level) return undefined // no choice ⇒ provider default, no shaping (backward-compatible)
  const entry = lookupModel(backend, modelId)
  if (!entry?.reasoning) return undefined // model has no thought-level control (e.g. gpt-4.1)
  const byWire = entry.reasoning.levels[level]
  if (!byWire) return undefined
  return byWire[entry.wire]
}

/** Does this model expose any thought-level control? (drives UI enable/disable) */
export function hasReasoning(backend: string | undefined, modelId: string): boolean {
  return !!lookupModel(backend, modelId)?.reasoning
}
