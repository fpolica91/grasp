// The agent-backend seam. grasp is agent-agnostic: any backend that can stream
// AgentEvents and touch the workspace can drive the post-editor loop. The contract
// is deliberately small — a backend takes a turn, emits events, returns the
// conversation state it wants back next turn (opaque to grasp).
export type Emit = (event: Record<string, unknown>) => void

export interface BackendTurn {
  workspace: string
  prompt: string
  history: unknown[]
  watch?: { entrypoint: string; input?: string }
  model?: string // model id within the backend; backend default when absent
  mode?: 'auto' | 'plan' // plan: read-only tools + propose a plan; no edits
}

export interface AgentBackend {
  id: string // 'glm' | 'claude-code' | 'openai'
  label: string
  models: string[] // first entry is the default
  // Honest availability: a backend that can't run says why (no key, no binary).
  available(): { ok: boolean; reason?: string }
  run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }>
}
