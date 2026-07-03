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

export interface GraspApi {
  chat(messages: ChatMessage[]): Promise<ChatResult>
  observe(params: ObserveParams): Promise<ObserveResult>
}
