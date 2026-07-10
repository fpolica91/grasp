import type { TraceDoc, TraceDiff, FuzzDiff } from './trace'
import type { ThoughtLevel } from './catalog'
// Shared contracts between main and renderer.

export type Provenance = 'observed' | 'declared' | 'unknown'

export interface Operand {
  name: string
  value: unknown
  display: string
  provenance: Provenance
  derived_from: string | null
}

// A structured multiple-choice question the agent asks the human (elicitation).
export interface ElicitOption {
  label: string
  description?: string
}

// Flow status — the phase a task is in (the end-to-end loop spine).
export type FlowStatus = 'idle' | 'planning' | 'awaiting-approval' | 'executing' | 'done' | 'failed'

// Git Graph: the commit history shown in the right pane.
export interface GitCommit {
  hash: string
  short: string
  parents: string[]
  author: string
  date: string
  subject: string
  refs: string // raw %d decoration, e.g. ' (HEAD -> main, origin/main)'
}
export interface GitGraph {
  ok: boolean
  error?: string
  branch: string
  commits: GitCommit[]
  branches: string[]
  dirty?: boolean
  ahead?: number
  behind?: number
}

// Repo Wiki: an AI-generated single-page repo doc, persisted to <ws>/.grasp/wiki.md.
export interface RepoWiki {
  ok: boolean
  markdown?: string
  generatedAt?: number
  error?: string
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
  language?: string // 'auto' (default), 'py', 'js', 'ts', 'go', 'java', 'csharp', 'cpp'
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
  language?: string // 'auto' (default), 'py', 'js', 'ts', 'go', 'java', 'csharp', 'cpp'
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

// The model trajectory: a faithful request/response inspector for every LLM API call
// the agent made — mirrors ZCode's "Model trajectory" view. Each call is one `#N` round
// trip with its Input (messages by role), Reasoning (thinking), Tool calls, Output, and
// Tool results. The agent emits one `trajectory_call` per completed callModel.
export interface TrajectoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  text: string
}
export interface TrajectoryToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}
export interface TrajectoryToolResult {
  id: string
  name: string
  output: string
}
export interface TrajectoryCall {
  n: number
  model: string
  source: string // 'Main session' | 'Title generation' | 'Compaction' | 'Subagent' | ...
  ts?: number // epoch ms the call started (rendered as a clock time, ZCode-style)
  ms?: number
  inputTokens?: number
  outputTokens?: number
  input: TrajectoryMessage[] // messages newly sent on this call (delta since the previous call)
  system?: string // system prompt — emitted once on the first call of a turn
  reasoning?: string // thinking block text
  output?: string // assistant text response
  toolCalls: TrajectoryToolCall[]
  toolResults: TrajectoryToolResult[]
}

// The workspace introduction (spec-v2 first contact): agent submits how/flows/suggestion
// as typed slots; grasp fills the rules section from model.yaml ITSELF and renders the
// surface deterministically. Chat prose is never the introduction.
export interface IntroDoc {
  workspace: string
  how: string
  flows: { name: string; what: string }[]
  rules: { id: string; text: string; status: 'staged' | 'uncompiled' | 'compiled' }[]
  suggestion: string
}

// Streaming events from the agent loop (main -> renderer).
export type AgentEvent =
  | { type: 'text'; text: string; parent?: string }
  | { type: 'text_delta'; text: string; parent?: string }
  | { type: 'text_end' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_end'; ms?: number }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parent?: string }
  | { type: 'tool_result'; id: string; name: string; summary: string; output?: string; parent?: string }
  | { type: 'trajectory_call'; call: TrajectoryCall }
  | { type: 'dataflow'; graph: GraphModel }
  | { type: 'dataflow_diff'; diff: GraphDiffModel }
  | { type: 'fuzz'; report: FuzzReport }
  | { type: 'trace'; trace: TraceDoc }
  | { type: 'trace_diff'; diff: TraceDiff }
  | { type: 'fuzz_diff'; fuzz: FuzzDiff }
  | { type: 'intro'; intro: IntroDoc }
  | { type: 'plan'; text: string }
  | { type: 'hook'; event: string; tool?: string; output: string }
  | { type: 'approval_request'; id: string; tool: string; input: Record<string, unknown> }
  | { type: 'elicitation_request'; id: string; header?: string; question: string; options: ElicitOption[]; multiSelect?: boolean; source?: string }
  | { type: 'usage'; input: number; output: number }
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
  thoughtLevel?: ThoughtLevel // reasoning/thinking effort (off/low/medium/high/max); undefined = provider default
  mode?: 'auto' | 'ask' | 'plan' // ask: approve each edit; plan: read-only, propose first
  budget?: number // optional per-turn token ceiling; the loop stops honestly when reached
  flowAuto?: boolean // false = Flow doesn't auto re-observe after edits; use flowNow() on demand
}

export interface BackendInfo {
  id: string
  label: string
  models: string[]
  ok: boolean
  reason?: string
}

// A durable workflow: an ordered list of prompt-steps run one at a time against a
// carried conversation. Progress persists so a restart mid-run resumes from the
// interrupted step (completed steps are skipped).
export interface WorkflowStep {
  prompt: string
  status: 'pending' | 'running' | 'done' | 'error'
}
export interface WorkflowRecord {
  id: string
  title: string
  workspace: string
  backend: string
  model: string
  budget?: number // optional per-step token ceiling applied to each step's turn
  steps: WorkflowStep[]
  currentStep: number // index of the step in progress / next to run
  status: 'idle' | 'running' | 'paused' | 'done'
  history: unknown[] // backend-opaque conversation carried across steps
  updatedAt: number
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
  calls?: TrajectoryCall[] // persisted model-trajectory inspector records (per-call request/response)
  traces?: unknown[] // persisted TraceDoc[] observed this session — restored on load, isolated per session
  surface?: unknown // the last Flow/report surface shown, so a reopened session shows its own flow, not a stale one
  parentId?: string // provenance: the session this was forked from
  titleUserSet?: boolean // true once the user renamed it -> autosave keeps the title
}

export interface SlashCommand {
  name: string
  description: string
  body: string
  skills?: string // if set, the run prepends a use_skill nudge (commands <-> skills unified)
  source: 'user' | 'project'
}

export interface GraspApi {
  chat(messages: ChatMessage[]): Promise<ChatResult>
  oneShot(opts: { backend: string; model?: string; system: string; user: string; maxTokens?: number }): Promise<{ ok: boolean; text?: string; error?: string }>
  observe(params: ObserveParams): Promise<ObserveResult>
  fuzz(params: FuzzParams): Promise<FuzzResult>
  agent(turn: AgentTurn): Promise<{ messages: unknown[] }>
  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  keyStatus(provider?: string): Promise<boolean>
  setKey(key: string, provider?: string): Promise<{ ok: boolean; error?: string; warning?: string }>
  defaultWorkspace(): Promise<string>
  backends(): Promise<BackendInfo[]>
  sessions(): Promise<SessionRecord[]>
  saveSession(rec: SessionRecord): Promise<void>
  deleteSession(id: string): Promise<void>
  forkSession(id: string): Promise<string> // returns the new session id, or '' if not found
  renameSession(id: string, title: string): Promise<void>
  approve(id: string, ok: boolean): Promise<void>
  resolveElicitation(id: string, answer: string | null): Promise<void>
  flowNow(workspace: string): Promise<{ ok: boolean; error?: string }>
  steer(text: string): Promise<void>
  stopAgent(): Promise<void>
  workflows(): Promise<WorkflowRecord[]>
  saveWorkflow(rec: WorkflowRecord): Promise<void>
  deleteWorkflow(id: string): Promise<void>
  projects(): Promise<{ path: string; name: string }[]>
  skills(workspace: string): Promise<{ name: string; description: string; source: string; enabled: boolean }[]>
  commands(workspace: string): Promise<SlashCommand[]>
  keybindings(): Promise<Record<string, string>>
  setSkillEnabled(name: string, enabled: boolean): Promise<void>
  mcpServers(workspace: string): Promise<Record<string, { command: string; args?: string[]; env?: Record<string, string> }>>
  saveMcpServer(name: string, command: string, args: string, env: string): Promise<void>
  deleteMcpServer(name: string): Promise<boolean>
  mcpStatus(workspace: string): Promise<{ name: string; ok: boolean; error?: string; toolCount: number }[]>
  plugins(workspace: string): Promise<{ name: string; description: string; source: 'user' | 'project'; hasSkills: boolean; mcpCount: number }[]>
  installPlugin(url: string): Promise<{ ok: boolean; name?: string; error?: string }>
  uninstallPlugin(name: string): Promise<{ ok: boolean; error?: string }>
  openFolder(): Promise<string>
  revealInFiles(key: string): Promise<void>
  detectApps(): Promise<{ id: string; name: string; command: string; icon: string }[]>
  openInApp(appId: string, workspace: string): Promise<boolean>
  remoteConnect(opts: { host: string; port?: number; user?: string; keyPath?: string; password?: string; passphrase?: string }): Promise<{ ok: boolean; error?: string; cwd?: string; platform?: string }>
  remoteDisconnect(): Promise<{ ok: boolean }>
  remoteStatus(): Promise<{ active: boolean; host?: string; user?: string; cwd?: string; platform?: string }>
  newProject(name: string): Promise<{ ok: boolean; path?: string; error?: string }>
  termCreate(id: string, cwd: string, cols: number, rows: number): void
  termWrite(id: string, data: string): void
  termResize(id: string, cols: number, rows: number): void
  termKill(id: string): void
  onTermData(cb: (id: string, data: string) => void): () => void
  onTermExit(cb: (id: string, exitCode: number) => void): () => void
  listTree(workspace: string): Promise<TreeNode[]>
  readFile(workspace: string, rel: string): Promise<{ ok: boolean; content?: string; error?: string }>
  writeFile(workspace: string, rel: string, content: string): Promise<{ ok: boolean; error?: string }>
  fileDiff(workspace: string, rel: string): Promise<{ ok: boolean; old: string; new: string; error?: string }>
  gitGraph(workspace: string): Promise<GitGraph>
  gitAction(workspace: string, op: 'fetch' | 'pull' | 'push' | 'stageAll' | 'commit' | 'checkout' | 'newBranch' | 'merge' | 'rebase', arg?: string): Promise<{ ok: boolean; out: string }>
  wikiRead(workspace: string): Promise<RepoWiki>
  wikiGenerate(workspace: string, backend: string, model?: string): Promise<RepoWiki>
  hooks(workspace: string): Promise<{ event: string; match?: string; command: string; timeout?: number }[]>
  codemapRead(workspace: string): Promise<RepoWiki>
  codemapGenerate(workspace: string, backend: string, model?: string): Promise<RepoWiki>
  gitDiff(workspace: string): Promise<{ ok: boolean; diff?: string; error?: string }>
}

export interface TreeNode {
  name: string
  path: string
  dir: boolean
  children?: TreeNode[]
}
