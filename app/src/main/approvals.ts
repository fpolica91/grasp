// Per-tool approvals (Ask mode). A mutating tool pauses and asks the human before it
// runs: the backend emits an approval_request event, the renderer shows Allow/Deny, and
// grasp:approve resolves the pending promise so the tool proceeds or is skipped.
import { randomUUID } from 'node:crypto'
import type { Emit } from './backends/types'
import type { ElicitOption } from '../shared/types'

const pending = new Map<string, (ok: boolean) => void>()

export function requestApproval(emit: Emit, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false)
    const done = (ok: boolean): void => {
      pending.delete(id)
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => done(false) // Stop/Esc denies the pending ask — the turn can end
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, done)
    emit({ type: 'approval_request', id, tool, input })
  })
}

export function resolveApproval(id: string, ok: boolean): void {
  const r = pending.get(id)
  if (r) {
    pending.delete(id)
    r(ok)
  }
}

// Elicitation: a structured multiple-choice question the agent asks the human.
// Resolves to the chosen answer (a label or the human's custom text), or null if dismissed.
export interface ElicitPayload {
  header?: string
  question: string
  options: ElicitOption[]
  multiSelect?: boolean
  source?: string
}

const pendingElicit = new Map<string, (answer: string | null) => void>()

export function requestElicitation(emit: Emit, payload: ElicitPayload, signal?: AbortSignal): Promise<string | null> {
  const id = randomUUID()
  return new Promise<string | null>((resolve) => {
    if (signal?.aborted) return resolve(null)
    const done = (answer: string | null): void => {
      pendingElicit.delete(id)
      signal?.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = (): void => done(null)
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingElicit.set(id, done)
    emit({ type: 'elicitation_request', id, ...payload })
  })
}

export function resolveElicitation(id: string, answer: string | null): void {
  const r = pendingElicit.get(id)
  if (r) {
    pendingElicit.delete(id)
    r(answer)
  }
}
