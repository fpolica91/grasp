// The agent dispatcher. grasp is agent-agnostic: each backend (GLM's wire, the
// Claude Code CLI, OpenAI) implements the same AgentBackend seam and streams the
// same AgentEvents — so the post-editor loop (edit → observe FOR REAL → question)
// is identical no matter which agent drives it.
import type { WebContents } from 'electron'
import { glmBackend } from './backends/glm'
import { claudeBackend } from './backends/claude'
import { openaiBackend } from './backends/openai'
import { checkpointWorkspace } from './checkpoint'
import type { AgentBackend, Emit } from './backends/types'

const BACKENDS: AgentBackend[] = [glmBackend, claudeBackend, openaiBackend]

// The user's stop button. One active turn at a time; stopping aborts its signal —
// owned loops end at the next await, the Claude Code child process is killed.
let activeAbort: AbortController | null = null
export function stopAgent(): void {
  activeAbort?.abort()
}

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
    budget?: number
    flowAuto?: boolean
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

  // TURN CHECKPOINTS — keep git HEAD equal to "the state before this turn", so the
  // Flow's A→B diff always has a baseline. Pre-turn: sweep any manual edits into a
  // checkpoint. Post-turn: checkpoint what the agent changed (skipped in plan mode —
  // read-only). No-ops on a clean tree.
  if (params.mode !== 'plan') checkpointWorkspace(workspace, `baseline before "${params.prompt.slice(0, 48)}"`)

  activeAbort?.abort() // a new turn supersedes any stuck one
  const ac = new AbortController()
  activeAbort = ac

  let result: { messages: unknown[] }
  try {
    result = await backend.run(
      {
        workspace,
        prompt: params.prompt,
        history: params.history,
        watch: params.watch,
        model: params.model,
        mode: params.mode,
        budget: params.budget,
        flowAuto: params.flowAuto,
        signal: ac.signal
      },
      emit
    )
  } finally {
    if (activeAbort === ac) activeAbort = null
  }

  if (params.mode !== 'plan') checkpointWorkspace(workspace, params.prompt.slice(0, 60))
  return result
}
