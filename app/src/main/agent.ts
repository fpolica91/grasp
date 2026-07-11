// The agent dispatcher. grasp is agent-agnostic: each backend (GLM's wire, the
// Claude Code CLI, OpenAI) implements the same AgentBackend seam and streams the
// same AgentEvents — so the post-editor loop (edit → observe FOR REAL → question)
// is identical no matter which agent drives it.
import type { WebContents } from 'electron'
import { glmBackend } from './backends/glm'
import { claudeBackend } from './backends/claude'
import { claudeCodeBackend } from './backends/claude-code'
import { openaiBackend } from './backends/openai'
import { providerBackends } from './backends/providers'
import { checkpointWorkspace, headSha } from './checkpoint'
import type { AgentBackend, Emit } from './backends/types'
import type { ThoughtLevel } from '../shared/catalog'
import { fireHooks, summarizeHookOutputs } from './hooks'

const BACKENDS: AgentBackend[] = [glmBackend, claudeBackend, claudeCodeBackend, openaiBackend, ...providerBackends]

// The user's stop button. One active turn at a time; stopping aborts its signal —
// owned loops end at the next await, the Claude Code child process is killed.
let activeAbort: AbortController | null = null
export function stopAgent(): void {
  activeAbort?.abort()
}

// Steer: a message the user injects into the in-flight turn. The owned loop drains
// this each iteration and inserts it as a user message before the next model call.
// One active turn ⇒ one queue (cleared at turn start so stale steers don't leak).
const steerQueue: string[] = []
export function steerAgent(text: string): void {
  const t = text?.trim()
  if (t) steerQueue.push(t)
}

export function listBackends(): { id: string; label: string; models: string[]; ok: boolean; reason?: string }[] {
  return BACKENDS.map((b) => ({ id: b.id, label: b.label, models: b.models, ...b.available() }))
}

// Anything with isDestroyed/send can drive a turn — the window's WebContents, or the
// test harness's collector. Structural, so the chat UI and the endpoint share one path.
export interface TurnSender {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export async function runAgent(
  sender: TurnSender,
  params: {
    workspace: string
    prompt: string
    history: unknown[]
    watch?: { entrypoint: string; input?: string }
    backend?: string
    model?: string
    thoughtLevel?: ThoughtLevel
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
  if (params.mode !== 'plan') {
    checkpointWorkspace(workspace, `baseline before "${params.prompt.slice(0, 48)}"`)
    // Tell the renderer this turn's baseline so the human can revert to it later.
    const baseline = headSha(workspace)
    if (baseline) emit({ type: 'checkpoint', sha: baseline })
  }

  activeAbort?.abort() // a new turn supersedes any stuck one
  const ac = new AbortController()
  activeAbort = ac
  steerQueue.length = 0 // fresh steer queue per turn

  let result: { messages: unknown[] }
  // Lifecycle hook: UserPromptSubmit fires before the turn runs (output surfaced in chat).
  const pre = summarizeHookOutputs(fireHooks({ workspace, event: 'UserPromptSubmit', prompt: params.prompt }))
  if (pre) emit({ type: 'hook', event: 'UserPromptSubmit', output: pre })
  try {
    result = await backend.run(
      {
        workspace,
        prompt: params.prompt,
        history: params.history,
        watch: params.watch,
        model: params.model,
        thoughtLevel: params.thoughtLevel,
        mode: params.mode,
        budget: params.budget,
        flowAuto: params.flowAuto,
        signal: ac.signal,
        steer: () => (steerQueue.length ? steerQueue.splice(0).join('\n\n') : undefined)
      },
      emit
    )
  } finally {
    if (activeAbort === ac) activeAbort = null
  }

  if (params.mode !== 'plan') checkpointWorkspace(workspace, params.prompt.slice(0, 60))
  // Lifecycle hook: Stop fires after the turn settles.
  const post = summarizeHookOutputs(fireHooks({ workspace, event: 'Stop' }))
  if (post) emit({ type: 'hook', event: 'Stop', output: post })
  return result
}
