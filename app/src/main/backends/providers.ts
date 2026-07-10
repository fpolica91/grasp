// Extra model providers (Layer B breadth) — thin configs over the shared Anthropic-wire
// loop. Each provider speaks the Anthropic Messages protocol (verified against ZCode's
// catalog); the base URL carries the provider's anthropic path prefix so base + /v1/messages
// lands on the right endpoint. Keys live in the vault under the provider id.
//
// Reasoning models among these accept the same `thinking` shaping as GLM/Claude (see catalog).
// Providers are additive; GLM stays the default. Override the model list per provider via
// GRASP_<ID>_MODELS if needed.
import { makeAnthropicBackend } from './anthropic'
import type { AgentBackend } from './types'

interface ProviderCfg {
  id: string
  label: string
  base: string // base + '/v1/messages' = the provider's anthropic endpoint
  defaultModel: string
  models: string[]
  keyEnvNote: string
}

export const PROVIDERS: ProviderCfg[] = [
  {
    id: 'moonshot',
    label: 'Moonshot',
    base: 'https://api.moonshot.cn/anthropic',
    defaultModel: 'kimi-k2.6',
    models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    keyEnvNote: 'no Moonshot key (api.moonshot.cn)'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    base: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    keyEnvNote: 'no DeepSeek key (api.deepseek.com)'
  },
  {
    id: 'qwen',
    label: 'Qwen',
    base: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3.5-plus',
    models: ['qwen3.5-plus', 'qwen3.5-flash', 'qwen3-max', 'qwen-plus', 'qwen-flash'],
    keyEnvNote: 'no Qwen key (DashScope)'
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    base: 'https://api.xiaomimimo.com/anthropic',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash', 'mimo-v2-pro'],
    keyEnvNote: 'no Xiaomi MiMo key'
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    base: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2'],
    keyEnvNote: 'no MiniMax key'
  },
  {
    id: 'bigmodel',
    label: 'BigModel (智谱)',
    base: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-4.6',
    models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.6', 'glm-4.5-air'],
    keyEnvNote: 'no BigModel key (open.bigmodel.cn)'
  }
]

export const providerBackends: AgentBackend[] = PROVIDERS.map((p) => {
  const models = (process.env[`GRASP_${p.id.toUpperCase()}_MODELS`] ?? p.models.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return makeAnthropicBackend({
    id: p.id,
    label: p.label,
    base: p.base,
    defaultModel: p.defaultModel,
    models,
    keyProvider: p.id,
    keyEnvNote: p.keyEnvNote
  })
})
