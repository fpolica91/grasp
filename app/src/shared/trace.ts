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
  language: string
  // OPTIONAL: the agent marks plumbing frames false so the UI collapses them by default.
  // grasp hardcodes NO classifier — legibility is the agent's call, surfaced as a node property.
  meaningful?: boolean // 'python' | 'js' | 'ts' | 'go' | …
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

// Align two traces of the SAME entry+input (old code state vs new) and report which
// frames appeared/vanished and which values changed. Frames match by call-path identity
// (the chain of function names from the root, disambiguated by sibling order) so an
// inserted call doesn't cascade into "everything changed". Pure — computed in the app.
function pathKey(f: TraceFrame, byId: Map<string, TraceFrame>, order: Map<string, number>): string {
  const parts: string[] = []
  let cur: TraceFrame | undefined = f
  while (cur) {
    parts.unshift(`${cur.fn}#${order.get(cur.id) ?? 0}`)
    cur = cur.parent ? byId.get(cur.parent) : undefined
  }
  return parts.join('/')
}

function keyed(t: TraceDoc): Map<string, TraceFrame> {
  const byId = new Map(t.frames.map((f) => [f.id, f]))
  // sibling order: index among frames sharing the same (parent, fn)
  const seen = new Map<string, number>()
  const order = new Map<string, number>()
  for (const f of [...t.frames].sort((a, b) => a.seq - b.seq)) {
    const sib = `${f.parent}:${f.fn}`
    const n = seen.get(sib) ?? 0
    order.set(f.id, n)
    seen.set(sib, n + 1)
  }
  const out = new Map<string, TraceFrame>()
  for (const f of t.frames) out.set(pathKey(f, byId, order), f)
  return out
}

export function diffTraces(oldT: TraceDoc, newT: TraceDoc): TraceDiff {
  const o = keyed(oldT)
  const n = keyed(newT)
  const frames: FrameDelta[] = []
  const questions: string[] = []
  const reprOf = (f: TraceFrame): Map<string, string> => {
    const m = new Map<string, string>()
    for (const a of f.args) m.set(`arg:${a.name}`, a.repr)
    m.set('→return', f.threw ? `threw ${f.threw.type}: ${f.threw.message}` : (f.ret?.repr ?? '(void)'))
    return m
  }
  // keep NEW order; classify each new frame, then append removed ones
  for (const [k, nf] of n) {
    const of = o.get(k)
    if (!of) {
      frames.push({ status: 'added', frame: nf, changes: [] })
      continue
    }
    const om = reprOf(of)
    const nm = reprOf(nf)
    const changes: { name: string; old: string; new: string }[] = []
    for (const [field, nv] of nm) {
      const ov = om.get(field)
      if (ov !== undefined && ov !== nv) changes.push({ name: field.replace('arg:', ''), old: ov, new: nv })
    }
    frames.push({ status: changes.length ? 'changed' : 'unchanged', frame: nf, changes })
    for (const c of changes) {
      if (c.name === '→return') questions.push(`${nf.fn} now ${c.new} (was ${c.old}) — intended?`)
      else questions.push(`${nf.fn}(${c.name}) is now ${c.new} (was ${c.old}) — intended?`)
    }
  }
  for (const [k, of] of o) {
    if (!n.has(k)) {
      frames.push({ status: 'removed', frame: of, changes: [] })
      questions.push(`${of.fn} no longer runs — intended?`)
    }
  }
  frames.sort((a, b) => (a.frame.seq ?? 0) - (b.frame.seq ?? 0))
  const changedCount = frames.filter((f) => f.status !== 'unchanged').length
  return {
    entry: newT.entry,
    oldRef: oldT.gitRef,
    newRef: newT.gitRef,
    changedCount,
    empty: changedCount === 0,
    frames,
    questions: [...new Set(questions)]
  }
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
