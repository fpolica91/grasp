// The agent dispatcher. grasp is agent-agnostic: each backend (GLM's wire, the
// Claude Code CLI, OpenAI) implements the same AgentBackend seam and streams the
// same AgentEvents — so the post-editor loop (edit → observe FOR REAL → question)
// is identical no matter which agent drives it.
import type { WebContents } from 'electron'
import { glmBackend } from './backends/glm'
import { claudeBackend } from './backends/claude'
import { openaiBackend } from './backends/openai'
import type { AgentBackend, Emit } from './backends/types'

const BACKENDS: AgentBackend[] = [glmBackend, claudeBackend, openaiBackend]

export function listBackends(): { id: string; label: string; models: string[]; ok: boolean; reason?: string }[] {
  return BACKENDS.map((b) => ({ id: b.id, label: b.label, models: b.models, ...b.available() }))
}

export async function runAgent(
  sender: WebContents,
  params: {
    workspace: string
    prompt: string
    history: unknown[]
    watch?: { entrypoint: string; input?: string }
    backend?: string
    model?: string
    mode?: 'auto' | 'ask' | 'plan'
  }
): Promise<{ messages: unknown[] }> {
  const emit: Emit = (event) => {
    if (!sender.isDestroyed()) sender.send('agent:event', event)
  }
  const backend = BACKENDS.find((b) => b.id === (params.backend ?? 'glm')) ?? BACKENDS[0]
  const avail = backend.available()
  if (!avail.ok) {
    emit({ type: 'error', error: `${backend.label} is not available: ${avail.reason}` })
    return { messages: params.history }
  }
  const workspace = params.workspace || process.env.GRASP_WORKSPACE || process.cwd()
  return backend.run(
    { workspace, prompt: params.prompt, history: params.history, watch: params.watch, model: params.model, mode: params.mode },
    emit
  )
}
