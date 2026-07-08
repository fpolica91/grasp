// GLM backend — the Anthropic Messages wire spoken by api.z.ai (GLM natively
// implements Anthropic Messages + tool_use — verified). A thin config over the
// shared loop in anthropic.ts; all the moat behavior lives there.
import { makeAnthropicBackend } from './anthropic'

const BASE = process.env.GRASP_MODEL_BASE ?? 'https://api.z.ai/api/anthropic'
const DEFAULT_MODEL = process.env.GRASP_MODEL ?? 'glm-5.2'

export const glmBackend = makeAnthropicBackend({
  id: 'glm',
  label: 'GLM',
  base: BASE,
  defaultModel: DEFAULT_MODEL,
  // glm-5.2 / glm-5.1 are the premium (opus-tier) models; glm-4.6 stays the fast default.
  // Override the whole list with GRASP_GLM_MODELS if needed.
  models: (process.env.GRASP_GLM_MODELS ?? 'glm-5.2,glm-5.1,glm-4.6,glm-4.5-air').split(',').map((s) => s.trim()).filter(Boolean),
  keyProvider: 'glm',
  keyEnvNote: 'no GLM key in the vault'
})
