// Claude backend — native Anthropic API (https://api.anthropic.com), no CLI.
// Same Anthropic Messages wire as GLM, so this is a thin config over the shared
// loop in anthropic.ts: grasp's own tool-use loop, the moat SYSTEM prompt, the
// model-trajectory inspector, ask/plan modes — all identical to the GLM path.
//
// (The Claude Code CLI is a separate backend in claude-code.ts — it brings its
// own tools. This one uses grasp's tools, like GLM/OpenAI.)
//
// Key: stored under the 'anthropic' vault provider (setKey/getKey('anthropic')).
// GRASP_ANTHROPIC_KEY / GRASP_CLAUDE_KEY are env overrides (dev/CI, never persisted).
// Base override: GRASP_CLAUDE_BASE (e.g. an Anthropic-compatible proxy).
import { makeAnthropicBackend } from './anthropic'

export const claudeBackend = makeAnthropicBackend({
  id: 'claude',
  label: 'Anthropic',
  base: process.env.GRASP_CLAUDE_BASE ?? 'https://api.anthropic.com',
  defaultModel: process.env.GRASP_CLAUDE_MODEL ?? 'claude-sonnet-5',
  // Claude 5 family. Default to Sonnet 5 (balanced); Opus 4.8 / Fable 5 for hard tasks,
  // Haiku 4.5 for speed. Override with GRASP_CLAUDE_MODELS.
  models: (process.env.GRASP_CLAUDE_MODELS ?? 'claude-sonnet-5,claude-opus-4-8,claude-fable-5,claude-haiku-4-5-20251001')
    .split(',').map((s) => s.trim()).filter(Boolean),
  keyProvider: 'anthropic',
  keyEnvNote: 'no Anthropic key in the vault (set GRASP_ANTHROPIC_KEY or add it in grasp)'
})
