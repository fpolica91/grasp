// Per-tool approvals (Ask mode). A mutating tool pauses and asks the human before it
// runs: the backend emits an approval_request event, the renderer shows Allow/Deny, and
// grasp:approve resolves the pending promise so the tool proceeds or is skipped.
import { randomUUID } from 'node:crypto'
import type { Emit } from './backends/types'

const pending = new Map<string, (ok: boolean) => void>()

export function requestApproval(emit: Emit, tool: string, input: Record<string, unknown>): Promise<boolean> {
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    pending.set(id, resolve)
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
