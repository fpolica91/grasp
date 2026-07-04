// grasp Trace protocol v1 — the ONE contract the Flow speaks.
//
// A trace is a real execution of the code, captured natively by whatever tracer fits
// the stack (the agent runs it via the `trace` skill; grasp does not ship an engine).
// grasp validates the shape, renders it as an interactive flow, diffs A→B, and keeps
// history. Nothing here is inferred: every value is a real observation or absent.
//
// HONESTY (non-negotiable, enforced by validateTrace):
//  • A tracer/tooling failure is NEVER a frame and NEVER an error node. It is the
//    `unobservable` field on the trace — "couldn't observe, here's why".
//  • `threw` on a frame is the code's REAL runtime exception, distinct from
//    `unobservable`. A transpile/attach/load failure is unobservable, not `threw`.
//  • The Flow never renders a verdict; it ends in questions the human adjudicates.

export const TRACE_VERSION = '1'

// A single value observed at some point in the run. `repr` is the display string;
// `json` is the structured value when it round-trips, else omitted (unrepresentable
// values keep only `repr`). No value is ever guessed.
export interface TraceValue {
  name: string // parameter / variable / field name
  repr: string // exact display, e.g. "'hello'", "3", "{a: 1}"
  json?: unknown // structured value when serializable
}

// One function frame: a real call that happened, with what flowed through it.
export interface TraceFrame {
  id: string // stable id within this trace (e.g. "f7")
  parent: string | null // caller frame id — this is what makes it a TREE
  seq: number // entry order across the whole run
  depth: number // nesting depth at entry (0 = root)
  fn: string // function name
  file: string // repo-relative source path (for click-to-source)
  line: number | null // function definition line
  callLine: number | null // line in the caller where this call happened
  args: TraceValue[] // arguments bound on entry
  ret: TraceValue | null // returned value (null if it threw or is void)
  threw: { type: string; message: string } | null // the code's REAL exception, if any
  durMs: number // measured wall-clock for this frame
  language: string // 'python' | 'js' | 'ts' | 'go' | …
}

export interface TraceDoc {
  grasp_trace_version: string
  id: string // unique id for this run (for history)
  createdAt: number // epoch ms (stamped by the app on receipt)
  entry: string // what was exercised (a function, a test name, a route)
  language: string
  how: string // how it was run (e.g. "npm test -- compress", "settrace on checkout")
  gitRef: string | null // the code state observed (HEAD sha / working-tree)
  input: Record<string, unknown> | null // the input that drove the run, if any
  status: 'returned' | 'threw' | 'unobservable'
  frames: TraceFrame[] // the call tree (empty iff unobservable)
  ret: TraceValue | null // the root frame's return
  threw: { type: string; message: string } | null // the root's real exception
  durationMs: number | null
  stdout: string // observed output (display-only evidence)
  stderr: string
  // Set IFF status === 'unobservable': why grasp could not observe this run. This is
  // the ONLY place a tooling failure appears — never as a frame or a thrown-error.
  unobservable: { reason: string; hint?: string } | null
}

// A→B: two traces of the same entry+input, one per code state. The view highlights
// which frames appeared/vanished and which values changed. Computed in the app.
export interface FrameDelta {
  status: 'unchanged' | 'changed' | 'added' | 'removed'
  frame: TraceFrame // the NEW frame (or the removed OLD one)
  changes: { name: string; old: string; new: string }[] // value deltas for 'changed'
}
export interface TraceDiff {
  entry: string
  oldRef: string | null
  newRef: string | null
  changedCount: number
  empty: boolean
  frames: FrameDelta[]
  questions: string[] // neutral "…— intended?" prompts; never a verdict
}

// Validate an incoming trace: agent-produced JSON must conform or grasp rejects it
// (honest error, not a mangled render). Returns null if valid, else the reason.
export function validateTrace(t: unknown): string | null {
  if (!t || typeof t !== 'object') return 'trace is not an object'
  const d = t as Partial<TraceDoc>
  if (d.grasp_trace_version !== TRACE_VERSION) return `unsupported trace version ${String(d.grasp_trace_version)}`
  if (d.status !== 'returned' && d.status !== 'threw' && d.status !== 'unobservable')
    return `bad status ${String(d.status)}`
  if (d.status === 'unobservable') {
    if (!d.unobservable?.reason) return 'unobservable trace must carry a reason'
    return null // frames legitimately empty
  }
  if (!Array.isArray(d.frames)) return 'frames must be an array'
  const ids = new Set(d.frames.map((f) => f.id))
  for (const f of d.frames as TraceFrame[]) {
    if (!f.id || typeof f.fn !== 'string') return 'frame missing id/fn'
    if (f.parent !== null && !ids.has(f.parent)) return `frame ${f.id} has dangling parent ${f.parent}`
    if (!Array.isArray(f.args)) return `frame ${f.id} args must be an array`
  }
  return null
}
