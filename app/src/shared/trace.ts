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

import type { ModelReport } from './model'

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
  // HOW this run was observed. 'app' = the running application driven on its real surface;
  // 'native-hook' = debugger/inspector attach; 'runner' = a test-runner probe — a DECLARED
  // fallback that must carry appAttempt; 'other' = explained in `how`. Enforced at submission:
  // a runner trace without a real attach attempt (or an enumerated impossibility) is refused.
  observation?: {
    channel: 'app' | 'native-hook' | 'runner' | 'other'
    appAttempt?: {
      attempted: boolean
      failure?: string // attempted=true: the CONCRETE error from the real attach attempt
      // attempted=false: 'deferred-heavyweight' = a runnable surface EXISTS (devenv, sim
      // fleet, compose stack) but booting it is disproportionate for this question — must
      // name the exact command in `path` so escalation is one word away.
      reason?: 'no-runnable-surface' | 'needs-credentials' | 'needs-hardware' | 'deferred-heavyweight'
      path?: string // deferred-heavyweight: the exact bring-up command the repo declares
      evidence?: string // no-runnable-surface: where you looked (docs, manifests, env configs) and found nothing
    }
  }
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
  // Root outcome change (status/return/thrown at the document level). Light traces carry
  // few or no frames — without this, old:threw vs new:returned read as "same flow",
  // a phantom SAMENESS (found by the headless API harness, 2026-07-07).
  rootChange: { old: string; new: string } | null
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

// The root outcome in one factual phrase — the unit scenario rows read in.
export function rootOutcome(t: TraceDoc): string {
  return t.status === 'threw' ? `threw ${t.threw?.type ?? ''}: ${t.threw?.message ?? ''}` : `returned ${t.ret?.repr ?? '(void)'}`
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
  const ro = rootOutcome(oldT)
  const rn = rootOutcome(newT)
  const rootChange = ro !== rn ? { old: ro, new: rn } : null
  if (rootChange) questions.push(`${newT.entry} now ${rn} (was ${ro}) — intended?`)
  return {
    entry: newT.entry,
    oldRef: oldT.gitRef,
    newRef: newT.gitRef,
    changedCount,
    empty: changedCount === 0 && rootChange === null,
    frames,
    rootChange,
    questions: [...new Set(questions)]
  }
}

// ── Differential fuzz: the diff that means something ──────────────────────────
// A single observed input proves nothing about the inputs you didn't try — a change
// that's catastrophic on an input you skipped reads as "same flow". So the honest A→B
// answer varies the input space and surfaces EVERY input where old and new diverge.
// The agent (the compiler) generates the spread and traces old+new on each; grasp diffs
// them here and renders only the divergences with a scope statement — never "safe".
export interface FuzzCase {
  label?: string // domain-language name: "edit a deleted task" — never input JSON
  scenario?: string // the named scenario this case exercises; model rules quantify over these
  input: unknown
  old: TraceDoc
  new: TraceDoc
}
export interface FuzzDivergence {
  label?: string
  input: unknown
  diff: TraceDiff
}
// One row per exercised case, in domain words — what the review surface reads (spec-v2 §4.2).
export interface CaseOutcome {
  label?: string
  scenario?: string
  input: unknown
  same: boolean
  old: string
  new: string
}
export interface FuzzDiff {
  entry: string
  oldRef: string | null
  newRef: string | null
  tried: number // pairs where BOTH sides were observed (unobservable pairs are dropped, not counted)
  diverged: number
  dropped: number // pairs dropped because one side was unobservable — never rendered as change
  cases: FuzzDivergence[]
  outcomes: CaseOutcome[] // every case, including the unchanged — scenario rows
  scope: string
  questions: string[]
  claim: CheckedClaim | null // the agent's proposed characterization, CHECKED by grasp (null = none submitted)
  axes: CheckedAxes | null // what the spread varied / held constant, verified against the cases
  report?: ModelReport | null // rules from .grasp/model.yaml checked against these cases (spec-v2 §1.6)
}

// ── The claim layer: a checked characterization of the divergence ─────────────
// "K of N diverged" is a sample statistic. The reviewer thinks one rung higher: a
// BOUNDARY ("diverges exactly when credit > subtotal") and a CONSEQUENCE ("old threw,
// new returns 0"). The agent may PROPOSE that claim; grasp CHECKS it here, case by
// case, against the divergence grasp computed itself — a claim is never trusted,
// never prose, and never a verdict. "Consistent" means it matched every observed
// case: corroboration on N cases, not proof over all inputs.

// A deliberately tiny, TOTAL predicate over a case input ('' path = the input itself).
// No loops, no user code — evaluating it is data-level checking, the same class of
// operation as diffTraces. The node cap is epistemics as much as legibility: a
// predicate as long as the divergence list it "explains" is an enumeration, not a
// characterization, and grasp says so.
export type PredRel = '<' | '<=' | '==' | '!=' | '>' | '>='
export type Pred =
  | { op: 'cmp'; path: string; rel: PredRel; value: number | string | boolean | null }
  | { op: 'cmpf'; path: string; rel: PredRel; other: string } // field vs field (e.g. credit > subtotal)
  | { op: 'and'; args: Pred[] }
  | { op: 'or'; args: Pred[] }
  | { op: 'not'; arg: Pred }
  | { op: 'has'; path: string }
  | { op: 'type'; path: string; is: 'number' | 'string' | 'boolean' | 'null' | 'object' | 'array' | 'missing' }
  | { op: 'len'; path: string; rel: PredRel; value: number }

export const PRED_MAX_NODES = 24
const PRED_MAX_DEPTH = 6
const MISMATCH_CAP = 12

// Dot-path into the case input; array indices are numeric parts; missing = undefined.
function atPath(input: unknown, path: string): unknown {
  let cur: unknown = input
  if (path === '') return cur
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const i = Number(part)
      cur = Number.isInteger(i) ? cur[i] : undefined
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

function ord(a: number | string, rel: PredRel, b: number | string): boolean {
  if (rel === '==') return a === b
  if (rel === '!=') return a !== b
  if (typeof a === 'number' && typeof b === 'number')
    return rel === '<' ? a < b : rel === '<=' ? a <= b : rel === '>' ? a > b : a >= b
  if (typeof a === 'string' && typeof b === 'string')
    return rel === '<' ? a < b : rel === '<=' ? a <= b : rel === '>' ? a > b : a >= b
  return false
}

// Total: always yields a boolean, never throws, never touches user code.
export function evalPred(p: Pred, input: unknown): boolean {
  switch (p.op) {
    case 'and':
      return p.args.every((a) => evalPred(a, input))
    case 'or':
      return p.args.some((a) => evalPred(a, input))
    case 'not':
      return !evalPred(p.arg, input)
    case 'has':
      return atPath(input, p.path) !== undefined
    case 'type': {
      const v = atPath(input, p.path)
      const t = v === undefined ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
      return t === p.is
    }
    case 'len': {
      const v = atPath(input, p.path)
      const n =
        typeof v === 'string' || Array.isArray(v)
          ? v.length
          : v !== null && typeof v === 'object'
            ? Object.keys(v).length
            : null
      return n !== null && ord(n, p.rel, p.value)
    }
    case 'cmp': {
      const v = atPath(input, p.path)
      if (p.rel === '==') return v === p.value
      if (p.rel === '!=') return v !== p.value
      if (typeof v === 'number' && typeof p.value === 'number') return ord(v, p.rel, p.value)
      if (typeof v === 'string' && typeof p.value === 'string') return ord(v, p.rel, p.value)
      return false
    }
    case 'cmpf': {
      const v = atPath(input, p.path)
      const w = atPath(input, p.other)
      if (p.rel === '==') return v === w
      if (p.rel === '!=') return v !== w
      if (typeof v === 'number' && typeof w === 'number') return ord(v, p.rel, w)
      if (typeof v === 'string' && typeof w === 'string') return ord(v, p.rel, w)
      return false
    }
  }
}

const wrapPred = (p: Pred): string => (p.op === 'and' || p.op === 'or' ? `(${renderPred(p)})` : renderPred(p))
// The human-readable form is RENDERED FROM the checked predicate — never agent prose,
// so there is no drift between what was checked and what is displayed.
export function renderPred(p: Pred): string {
  switch (p.op) {
    case 'and':
      return p.args.map(wrapPred).join(' and ')
    case 'or':
      return p.args.map(wrapPred).join(' or ')
    case 'not':
      return `not ${wrapPred(p.arg)}`
    case 'has':
      return `${p.path || 'input'} is present`
    case 'type':
      return `${p.path || 'input'} is ${p.is}`
    case 'len':
      return `len(${p.path || 'input'}) ${p.rel} ${p.value}`
    case 'cmp':
      return `${p.path || 'input'} ${p.rel} ${JSON.stringify(p.value)}`
    case 'cmpf':
      return `${p.path || 'input'} ${p.rel} ${p.other || 'input'}`
  }
}

export function predSize(p: Pred): number {
  switch (p.op) {
    case 'and':
    case 'or':
      return 1 + p.args.reduce((n, a) => n + predSize(a), 0)
    case 'not':
      return 1 + predSize(p.arg)
    default:
      return 1
  }
}

// Structural validation of an agent-submitted predicate (grasp refuses, never guesses).
export function validatePred(u: unknown, depth = 0): string | null {
  if (depth > PRED_MAX_DEPTH) return `predicate nests deeper than ${PRED_MAX_DEPTH}`
  if (!u || typeof u !== 'object') return 'predicate node must be an object'
  const p = u as Record<string, unknown>
  const rels = ['<', '<=', '==', '!=', '>', '>=']
  const op = p.op
  let err: string | null = null
  if (op === 'and' || op === 'or') {
    if (!Array.isArray(p.args) || p.args.length === 0) err = `${String(op)} needs a non-empty args array`
    else
      for (const a of p.args) {
        err = validatePred(a, depth + 1)
        if (err) break
      }
  } else if (op === 'not') {
    err = validatePred(p.arg, depth + 1)
  } else if (op === 'has') {
    if (typeof p.path !== 'string') err = 'has needs a string path'
  } else if (op === 'type') {
    if (typeof p.path !== 'string') err = 'type needs a string path'
    else if (!['number', 'string', 'boolean', 'null', 'object', 'array', 'missing'].includes(p.is as string))
      err = `bad type ${String(p.is)}`
  } else if (op === 'len') {
    if (typeof p.path !== 'string') err = 'len needs a string path'
    else if (!rels.includes(p.rel as string)) err = `bad rel ${String(p.rel)}`
    else if (typeof p.value !== 'number') err = 'len value must be a number'
  } else if (op === 'cmp') {
    if (typeof p.path !== 'string') err = 'cmp needs a string path'
    else if (!rels.includes(p.rel as string)) err = `bad rel ${String(p.rel)}`
    else if (
      typeof p.value !== 'number' &&
      typeof p.value !== 'string' &&
      typeof p.value !== 'boolean' &&
      p.value !== null
    )
      err = 'cmp value must be number | string | boolean | null'
  } else if (op === 'cmpf') {
    if (typeof p.path !== 'string') err = 'cmpf needs a string path'
    else if (!rels.includes(p.rel as string)) err = `bad rel ${String(p.rel)}`
    else if (typeof p.other !== 'string') err = 'cmpf needs a string other (the field to compare against)'
  } else {
    err = `unknown predicate op ${String(op)}`
  }
  if (err) return err
  if (depth === 0 && predSize(u as Pred) > PRED_MAX_NODES)
    return `predicate has ${predSize(u as Pred)} nodes (max ${PRED_MAX_NODES}) — that is an enumeration, not a boundary`
  return null
}

// The CONSEQUENCE half of a claim: a pattern over each diverging case's observed root
// outcome, old side vs new side. Matched exactly against the submitted traces.
export interface OutcomePattern {
  status?: 'returned' | 'threw'
  threwType?: string // exact trace.threw.type
  returns?: string // exact trace.ret.repr
}
export interface EffectPattern {
  old?: OutcomePattern
  new?: OutcomePattern
}
export interface FuzzClaim {
  where: Pred // the boundary: which inputs diverge
  effect?: EffectPattern // what changes there
}
export interface FuzzAxes {
  varied?: { path: string; note?: string }[] // what the spread moved (note: e.g. "[0, 500]")
  held?: { path: string }[] // what it deliberately froze
}

function matchOutcome(t: TraceDoc, pat: OutcomePattern): boolean {
  if (pat.status !== undefined && t.status !== pat.status) return false
  if (pat.threwType !== undefined && t.threw?.type !== pat.threwType) return false
  if (pat.returns !== undefined && t.ret?.repr !== pat.returns) return false
  return true
}
function renderOutcome(side: 'old' | 'new', pat: OutcomePattern): string {
  if (pat.status === 'threw' || pat.threwType !== undefined) return `${side} threw${pat.threwType ? ` ${pat.threwType}` : ''}`
  if (pat.status === 'returned' || pat.returns !== undefined)
    return `${side} returned${pat.returns !== undefined ? ` ${pat.returns}` : ''}`
  return ''
}

export function validateClaim(u: unknown): string | null {
  if (!u || typeof u !== 'object') return 'claim must be an object { where, effect? }'
  const c = u as Record<string, unknown>
  const we = validatePred(c.where)
  if (we) return `claim.where: ${we}`
  if (c.effect !== undefined) {
    if (!c.effect || typeof c.effect !== 'object') return 'claim.effect must be an object { old?, new? }'
    const e = c.effect as Record<string, unknown>
    if (e.old === undefined && e.new === undefined) return 'claim.effect needs old and/or new'
    for (const side of ['old', 'new'] as const) {
      const s = e[side]
      if (s === undefined) continue
      if (!s || typeof s !== 'object') return `claim.effect.${side} must be an object`
      const o = s as Record<string, unknown>
      if (o.status !== undefined && o.status !== 'returned' && o.status !== 'threw')
        return `claim.effect.${side}.status must be returned | threw`
      if (o.threwType !== undefined && typeof o.threwType !== 'string') return `claim.effect.${side}.threwType must be a string`
      if (o.returns !== undefined && typeof o.returns !== 'string') return `claim.effect.${side}.returns must be a string`
    }
  }
  return null
}

export function validateAxes(u: unknown): string | null {
  if (!u || typeof u !== 'object') return 'axes must be an object { varied?, held? }'
  const a = u as Record<string, unknown>
  for (const k of ['varied', 'held'] as const) {
    const arr = a[k]
    if (arr === undefined) continue
    if (!Array.isArray(arr)) return `axes.${k} must be an array`
    for (const e of arr)
      if (!e || typeof e !== 'object' || typeof (e as Record<string, unknown>).path !== 'string')
        return `axes.${k} entries need a string path`
  }
  return null
}

// The claim, CHECKED: grasp cross-tabulates the predicate against the divergence it
// computed per case and reports one of four observed outcomes. Nothing is verified —
// a consistent claim SURVIVED N refutation attempts, and the summary says exactly that.
export interface ClaimMismatch {
  input: unknown
  observed: 'diverged' | 'same'
  claimed: 'diverged' | 'same'
}
export interface CheckedClaim {
  where: Pred
  rendered: string // grasp-rendered from the checked predicate — never agent prose
  effectRendered: string | null
  status: 'consistent' | 'mismatched' | 'untested' | 'enumeration'
  tried: number
  matched: number
  mismatchCount: number
  mismatches: ClaimMismatch[] // capped for render; mismatchCount is the true total
  support: { satisfyDiverged: number; satisfySame: number; failDiverged: number; failSame: number }
  effect: { held: number; broke: number } | null
  predNodes: number
  summary: string
}
export interface CheckedAxes {
  varied: { path: string; note?: string; distinct: number }[] // distinct observed values per axis
  held: { path: string; repr: string; constant: boolean }[]
  issues: string[] // factual disagreements between the declared axes and the observed cases
}

interface CaseRun {
  label?: string
  scenario?: string
  input: unknown
  old: TraceDoc
  new: TraceDoc
  diff: TraceDiff
}

function checkClaim(claim: FuzzClaim, runs: CaseRun[]): CheckedClaim {
  const support = { satisfyDiverged: 0, satisfySame: 0, failDiverged: 0, failSame: 0 }
  const mismatches: ClaimMismatch[] = []
  let effectHeld = 0
  let effectBroke = 0
  for (const r of runs) {
    const sat = evalPred(claim.where, r.input)
    const div = !r.diff.empty
    if (sat && div) support.satisfyDiverged++
    else if (sat) support.satisfySame++
    else if (div) support.failDiverged++
    else support.failSame++
    if (sat !== div && mismatches.length < MISMATCH_CAP)
      mismatches.push({ input: r.input, observed: div ? 'diverged' : 'same', claimed: sat ? 'diverged' : 'same' })
    if (claim.effect && sat && div) {
      const ok =
        (!claim.effect.old || matchOutcome(r.old, claim.effect.old)) &&
        (!claim.effect.new || matchOutcome(r.new, claim.effect.new))
      if (ok) effectHeld++
      else effectBroke++
    }
  }
  const tried = runs.length
  const diverged = support.satisfyDiverged + support.failDiverged
  const mismatchCount = support.satisfySame + support.failDiverged
  const matched = tried - mismatchCount
  const predNodes = predSize(claim.where)
  const rendered = renderPred(claim.where)
  const effParts = claim.effect
    ? [
        claim.effect.old ? renderOutcome('old', claim.effect.old) : '',
        claim.effect.new ? renderOutcome('new', claim.effect.new) : ''
      ].filter(Boolean)
    : []
  const effectRendered = effParts.length ? effParts.join(' → ') : null
  const satisfy = support.satisfyDiverged + support.satisfySame
  const fail = support.failDiverged + support.failSame
  const compresses = predNodes <= Math.max(4, Math.ceil(diverged / 2))
  const status: CheckedClaim['status'] =
    mismatchCount > 0 ? 'mismatched' : satisfy === 0 || fail === 0 ? 'untested' : !compresses ? 'enumeration' : 'consistent'
  let summary: string
  if (status === 'consistent') {
    summary = `Where ${rendered}: matched all ${tried} observed cases — ${support.satisfyDiverged} satisfy it (every one diverged), ${support.failSame} do not (none diverged). ${tried} observed cases are not every input.`
    if (effectRendered)
      summary +=
        effectBroke === 0
          ? ` Effect (${effectRendered}) held on all ${effectHeld} diverging cases.`
          : ` Effect (${effectRendered}) held on ${effectHeld} of ${effectHeld + effectBroke} diverging cases.`
  } else if (status === 'mismatched') {
    summary = `Claim "${rendered}" did not hold on ${mismatchCount} of ${tried} observed cases — counterexamples shown.`
  } else if (status === 'untested') {
    summary = `Claim "${rendered}" is untested on this spread: ${satisfy === 0 ? 'no observed case satisfies it' : 'no observed case fails it'} — no straddle, no evidence either way. Generate cases on both sides of the boundary.`
  } else {
    summary = `Claim "${rendered}" matched all ${tried} observed cases, but ${predNodes} predicate nodes for ${diverged} divergences is closer to an enumeration than a boundary — it does not compress what it explains.`
  }
  return {
    where: claim.where,
    rendered,
    effectRendered,
    status,
    tried,
    matched,
    mismatchCount,
    mismatches,
    support,
    effect: claim.effect ? { held: effectHeld, broke: effectBroke } : null,
    predNodes,
    summary
  }
}

// Axes are agent-declared but grasp-verified: a "varied" axis must actually vary in the
// observed cases, a "held" axis must actually be constant. What was held still is the
// fine print of every claim — an axis never moved is a claim never tested.
function checkAxes(axes: FuzzAxes, inputs: unknown[]): CheckedAxes {
  const issues: string[] = []
  const varied: CheckedAxes['varied'] = []
  for (const a of axes.varied ?? []) {
    const distinct = new Set(inputs.map((i) => JSON.stringify(atPath(i, a.path)) ?? 'undefined')).size
    varied.push({ path: a.path, note: a.note, distinct })
    if (distinct <= 1)
      issues.push(
        `${a.path} was declared varied but has ${distinct} distinct observed value${distinct === 1 ? '' : 's'} — claims about it are untested`
      )
  }
  const held: CheckedAxes['held'] = []
  for (const h of axes.held ?? []) {
    const vals = new Set(inputs.map((i) => JSON.stringify(atPath(i, h.path)) ?? 'undefined'))
    const constant = vals.size <= 1
    held.push({ path: h.path, repr: [...vals][0] ?? 'undefined', constant })
    if (!constant) issues.push(`${h.path} was declared held constant but takes ${vals.size} observed values`)
  }
  return { varied, held, issues }
}

// Diff each old/new pair; keep only the inputs where behavior actually changed. grasp
// computes divergence from the real traces — it does not trust an agent's "diverged"
// claim — and, when a claim/axes are submitted, checks THOSE against the same cases.
export function buildFuzzDiff(entry: string, cases: FuzzCase[], claim?: FuzzClaim, axes?: FuzzAxes): FuzzDiff {
  const runs: CaseRun[] = []
  let dropped = 0
  let oldRef: string | null = null
  let newRef: string | null = null
  for (const c of cases) {
    if (!c.old || !c.new) continue
    // No phantom change (moat): a pair where either side could not be observed is
    // dropped, never surfaced as fake behavior. The drop itself is reported honestly.
    if (c.old.status === 'unobservable' || c.new.status === 'unobservable') {
      dropped++
      continue
    }
    oldRef = oldRef ?? c.old.gitRef
    newRef = newRef ?? c.new.gitRef
    runs.push({ label: c.label, scenario: c.scenario, input: c.input, old: c.old, new: c.new, diff: diffTraces(c.old, c.new) })
  }
  const divergences: FuzzDivergence[] = []
  const questions = new Set<string>()
  const outcomes: CaseOutcome[] = []
  for (const r of runs) {
    outcomes.push({ label: r.label, scenario: r.scenario, input: r.input, same: r.diff.empty, old: rootOutcome(r.old), new: rootOutcome(r.new) })
    if (!r.diff.empty) {
      divergences.push({ label: r.label, input: r.input, diff: r.diff })
      for (const q of r.diff.questions) questions.add(q)
    }
  }
  const tried = runs.length
  const diverged = divergences.length
  const checked = claim ? checkClaim(claim, runs) : null
  if (checked && checked.status === 'consistent')
    questions.add(
      `where ${checked.rendered}: ${checked.effectRendered ?? 'behavior diverges'} (${checked.support.satisfyDiverged} of ${tried} observed cases) — intended?`
    )
  const checkedAxes = axes ? checkAxes(axes, runs.map((r) => r.input)) : null
  const dropNote = dropped
    ? ` ${dropped} pair(s) dropped: one side unobservable — a change that could not be observed is never rendered.`
    : ''
  const scope =
    diverged === 0
      ? `Varied ${tried} input${tried === 1 ? '' : 's'}; no divergence observed. That is not proof of safety — it is ${tried} observed path${tried === 1 ? '' : 's'}, not every possible input.${dropNote}`
      : `Varied ${tried} input${tried === 1 ? '' : 's'}; behavior diverged on ${diverged}. Each divergence below is an observed fact for you to adjudicate — grasp does not call it a bug.${dropNote}`
  return {
    entry,
    oldRef,
    newRef,
    tried,
    diverged,
    dropped,
    cases: divergences,
    outcomes,
    scope,
    questions: [...questions],
    claim: checked,
    axes: checkedAxes
  }
}

// The channel declaration, enforced: "it would take effort" is not a reason to skip the
// running app. Either the attach was really attempted (bring the concrete failure) or the
// impossibility is one grasp names. This is structure because prose was not enough.
export function validateObservation(t: TraceDoc): string | null {
  if (t.status === 'unobservable') return null
  const o = t.observation
  if (!o || !['app', 'native-hook', 'runner', 'other'].includes(o.channel))
    return 'observation.channel is required: "app" (the running application), "native-hook" (debugger/inspector), "runner" (test-runner probe — a declared fallback), or "other". State how this run was observed.'
  if (o.channel === 'runner') {
    const a = o.appAttempt
    if (!a)
      return 'a runner trace requires observation.appAttempt: {attempted: true, failure: "<concrete error from the real attach attempt>"} or {attempted: false, reason: "no-runnable-surface" | "needs-credentials" | "needs-hardware"}. "It would require booting the app" is not a reason — boot it.'
    if (a.attempted) {
      if (!a.failure || !a.failure.trim()) return 'appAttempt.attempted = true requires failure: the concrete error the real attach attempt produced.'
    } else if (a.reason === 'deferred-heavyweight') {
      if (!a.path || !a.path.trim())
        return 'reason "deferred-heavyweight" requires path: the exact bring-up command the repo declares. A deferral without an escalation path is just a refusal.'
    } else if (a.reason === 'no-runnable-surface') {
      if (!a.evidence || !a.evidence.trim())
        return 'reason "no-runnable-surface" requires evidence: state where you looked — the repo\'s own docs, manifests, task-runner and dev-environment configs — and found no way to run it. The claim is about the REPO, not the symbol you narrowed to.'
    } else if (a.reason !== 'needs-credentials' && a.reason !== 'needs-hardware') {
      return 'appAttempt.attempted = false requires reason: no-runnable-surface | needs-credentials | needs-hardware | deferred-heavyweight (with path). Effort alone is not on the list.'
    }
  }
  return null
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
