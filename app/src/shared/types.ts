// Shared contracts between main and renderer.

export type Provenance = 'observed' | 'declared' | 'unknown'

export interface Operand {
  name: string
  value: unknown
  display: string
  provenance: Provenance
  derived_from: string | null
}

export interface GraphNode {
  id: string
  kind: string
  label: string
  business_meaningful: boolean
  presence: 'observed' | 'ghosted'
  terminal: boolean
  operands: Operand[]
  business_objects: unknown[]
  question: string | null
  evidence: string | null
}

export interface GraphModel {
  grasp_graph_version: string
  entrypoint: string
  mode: string
  transparency: {
    classifier_mode: string
    vocab_size: number
    fallback_reason: string | null
    containment_level: string
  }
  coverage: { kind: string; inputs_observed: number; note: string }
  default_view: string[]
  nodes: GraphNode[]
  edges: unknown[]
  questions: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  ok: boolean
  text: string
  error?: string
}

export interface ObserveParams {
  repo: string
  entrypoint: string
  input?: string
}

export interface ObserveResult {
  ok: boolean
  observed: boolean
  graph?: GraphModel
  error?: string | null
}

// The A->B change view (agent edited code -> what did the behavior do).
export interface OperandDelta {
  field: string
  old: string
  new: string
  provenance: Provenance
}

export interface DiffNode {
  id: string
  status: 'unchanged' | 'changed' | 'added' | 'removed' | 'moved'
  kind: string
  label: string
  presence: 'observed' | 'ghosted'
  operands: Operand[]
  deltas: OperandDelta[]
}

export interface GraphDiffModel {
  grasp_graph_diff_version: string
  entrypoint: string
  old_ref: string | null
  new_ref: string | null
  transparency: { classifier_mode: string; vocab_size: number }
  changed_count: number
  empty: boolean
  honest_message: string | null
  nodes: DiffNode[]
  questions: string[]
}

export interface DiffParams {
  repo: string
  entrypoint: string
  oldRef: string
  input?: string
}

export interface DiffResult {
  ok: boolean
  changed?: boolean
  graphDiff?: GraphDiffModel
  error?: string | null
}

// Fuzzing: vary the input across a schema and surface which operands bent, the failing
// cases, and the gaps — each with a reproducing input. The new stack trace.
export interface FuzzVaried {
  kind: string
  label: string
  operand: string
  values: { value: unknown; reproduce_with: Record<string, unknown> }[]
}
export interface FuzzRaise {
  type: string
  message: string
  reproduce_with: Record<string, unknown>
}
export interface FuzzErrorVariant {
  input: Record<string, unknown>
  error: string
}
export interface FuzzReport {
  entrypoint: string
  variant_count: number
  seed: number
  egress: string
  containment_level: string
  classifier_mode: string
  vocab_size: number
  fallback_reason: string | null
  ran: number
  raises: FuzzRaise[]
  errors: FuzzErrorVariant[]
  varied: FuzzVaried[]
}
export interface FuzzParams {
  repo: string
  entrypoint: string
  schema: string
  variants?: number
  allowEgress?: boolean // false (default) = walled (network denied); true = fuzz for real
}
export interface FuzzResult {
  ok: boolean
  varied?: boolean
  report?: FuzzReport
  error?: string | null
}

// Streaming events from the agent loop (main -> renderer).
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; summary: string }
  | { type: 'dataflow'; graph: GraphModel }
  | { type: 'dataflow_diff'; diff: GraphDiffModel }
  | { type: 'fuzz'; report: FuzzReport }
  | { type: 'done'; note?: string }
  | { type: 'error'; error: string }

// What grasp continuously surfaces as the agent works: after every edit, it re-observes
// this entrypoint and streams the evolving dataflow (live compiler/debugger).
export interface Watch {
  entrypoint: string
  input?: string
}

export interface AgentTurn {
  workspace: string
  prompt: string
  history: unknown[]
  watch?: Watch
  backend?: string // backend id ('glm' | 'claude-code' | 'openai'); default glm
  model?: string // model id within the backend
}

export interface BackendInfo {
  id: string
  label: string
  models: string[]
  ok: boolean
  reason?: string
}

// A persisted session: transcript for display + backend-opaque history so the
// conversation continues across app launches.
export interface SessionRecord {
  id: string
  title: string
  updatedAt: number
  backend: string
  model: string
  workspace: string
  transcript: unknown[]
  history: unknown[]
}

export interface GraspApi {
  chat(messages: ChatMessage[]): Promise<ChatResult>
  observe(params: ObserveParams): Promise<ObserveResult>
  fuzz(params: FuzzParams): Promise<FuzzResult>
  agent(turn: AgentTurn): Promise<{ messages: unknown[] }>
  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  keyStatus(): Promise<boolean>
  setKey(key: string): Promise<{ ok: boolean; error?: string; warning?: string }>
  defaultWorkspace(): Promise<string>
  backends(): Promise<BackendInfo[]>
  sessions(): Promise<SessionRecord[]>
  saveSession(rec: SessionRecord): Promise<void>
  deleteSession(id: string): Promise<void>
}
