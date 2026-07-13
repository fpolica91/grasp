// grasp Behavior Model v1 — the durable statement of what the human requires (spec-v2 §1.1).
// Lives at <workspace>/.grasp/model.yaml, git-tracked, human-owned. grasp READS the model
// (it is the human's declared judgment, replayed) and CHECKS it against observed cases —
// it never authors a rule and never asserts beyond the four-word vocabulary (spec-v2 §2):
// conforms / violated / untested / novel. "Violated" only ever cites a judgment the human
// pre-supplied (authored or ratified); grasp adds no judgment of its own.
import { evalPred, validatePred, type Pred, type TraceDoc } from './trace'

// The observed-outcome vocabulary a rule expects: the trace's own statuses, never model-side
// words like "rejected" — the agent compiles human text into this form (spec-v2 §6.2).
export interface OutcomeExpect {
  status?: 'returned' | 'threw'
  threwType?: string // exact trace.threw.type
  returns?: string // exact trace.ret.repr
}

export interface RuleCheck {
  scenario: string // the named scenario this rule quantifies over
  where?: Pred // optional restriction over the case input (claim DSL)
  expect: OutcomeExpect // what every covered case must observe
}

export interface ModelRule {
  id: string
  text: string // the human's sentence — the judgment itself
  origin: 'authored' | 'ratified'
  ratified?: string // date, for origin: ratified
  evidence?: string
  staged?: boolean // proposed by the agent, awaiting human confirmation — not yet enforced
  check?: RuleCheck // absent = uncompiled: visible debt, reported untested
}

export interface ModelExample {
  label: string
  scenario: string
  input: unknown
  expect: OutcomeExpect
}

export interface BehaviorModel {
  grasp_model_version: number
  feature?: string
  states?: Record<string, string[]>
  rules?: ModelRule[]
  examples?: ModelExample[]
}

const OUTCOME_KEYS = ['status', 'threwType', 'returns'] as const

function validateExpect(u: unknown, at: string): string | null {
  if (!u || typeof u !== 'object') return `${at}.expect must be an object`
  const e = u as Record<string, unknown>
  if (e.status !== undefined && e.status !== 'returned' && e.status !== 'threw')
    return `${at}.expect.status must be returned | threw (the observed vocabulary — compile "rejected"-style words into what the code actually does)`
  if (e.threwType !== undefined && typeof e.threwType !== 'string') return `${at}.expect.threwType must be a string`
  if (e.returns !== undefined && typeof e.returns !== 'string') return `${at}.expect.returns must be a string`
  if (!OUTCOME_KEYS.some((k) => e[k] !== undefined)) return `${at}.expect needs at least one of status | threwType | returns`
  return null
}

// Structural validation: grasp refuses a malformed model with a teaching reason, exactly
// like traces and claims. An invalid model never silently disables checking.
export function validateModel(u: unknown): string | null {
  if (!u || typeof u !== 'object') return 'model must be a mapping'
  const m = u as Record<string, unknown>
  if (m.grasp_model_version !== 1) return `unsupported grasp_model_version ${String(m.grasp_model_version)} (expected 1)`
  if (m.states !== undefined) {
    if (!m.states || typeof m.states !== 'object') return 'states must be a mapping of name -> list of values'
    for (const [k, v] of Object.entries(m.states as Record<string, unknown>))
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `states.${k} must be a list of strings`
  }
  const ids = new Set<string>()
  const rules = m.rules ?? []
  if (!Array.isArray(rules)) return 'rules must be a list'
  for (const r of rules as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') return 'each rule must be a mapping'
    if (typeof r.id !== 'string' || !r.id) return 'each rule needs a string id'
    if (ids.has(r.id)) return `duplicate rule id ${r.id}`
    ids.add(r.id)
    if (typeof r.text !== 'string' || !r.text) return `rule ${r.id} needs text — the human sentence IS the rule`
    if (r.origin !== 'authored' && r.origin !== 'ratified') return `rule ${r.id}: origin must be authored | ratified`
    if (r.origin === 'ratified' && typeof r.ratified !== 'string') return `rule ${r.id}: origin ratified requires a ratified date`
    if (r.check !== undefined) {
      const c = r.check as Record<string, unknown>
      if (!c || typeof c !== 'object') return `rule ${r.id}: check must be a mapping`
      if (typeof c.scenario !== 'string' || !c.scenario) return `rule ${r.id}: check.scenario is required`
      if (c.where !== undefined) {
        const pe = validatePred(c.where)
        if (pe) return `rule ${r.id}: check.where: ${pe}`
      }
      const ee = validateExpect(c.expect, `rule ${r.id}`)
      if (ee) return ee
    }
  }
  const examples = m.examples ?? []
  if (!Array.isArray(examples)) return 'examples must be a list'
  for (const ex of examples as Record<string, unknown>[]) {
    if (!ex || typeof ex !== 'object') return 'each example must be a mapping'
    if (typeof ex.label !== 'string' || !ex.label) return 'each example needs a label'
    if (typeof ex.scenario !== 'string' || !ex.scenario) return `example "${String(ex.label)}" needs a scenario`
    const ee = validateExpect(ex.expect, `example "${String(ex.label)}"`)
    if (ee) return ee
  }
  return null
}

// ── Checking (spec-v2 §3): grasp recomputes everything itself, per observed case ──────

export interface CaseRun {
  label?: string
  scenario?: string
  input: unknown
  newT: TraceDoc // the model is checked against CURRENT behavior (the new side)
  diverged: boolean // old vs new, computed by grasp
}

export interface Counterexample {
  label?: string
  input: unknown
  observed: string // what the new side actually did, rendered factually
}

export interface RuleRow {
  id: string
  text: string
  origin: 'authored' | 'ratified' | 'example'
  ratified?: string
  status: 'conforms' | 'violated' | 'untested'
  covered: number // observed cases this rule quantified over
  note?: string // e.g. uncompiled / staged — visible debt, never silent
  counterexamples: Counterexample[] // capped for render
}

export interface NovelRow {
  label?: string
  scenario?: string
  input: unknown
  change: string // the observed old->new change summary (from the fuzz diff questions)
}

export interface ModelReport {
  feature?: string
  rows: RuleRow[]
  novel: NovelRow[] // diverged cases no rule covers — the ONLY rows that ask "— intended?"
  scope: string
}

function matchExpect(t: TraceDoc, e: OutcomeExpect): boolean {
  if (e.status !== undefined && t.status !== e.status) return false
  if (e.threwType !== undefined && t.threw?.type !== e.threwType) return false
  if (e.returns !== undefined && t.ret?.repr !== e.returns) return false
  return true
}

function observedOf(t: TraceDoc): string {
  return t.status === 'threw' ? `threw ${t.threw?.type ?? ''}`.trim() : `returned ${t.ret?.repr ?? '(void)'}`
}

const CEX_CAP = 8

export function checkModel(model: BehaviorModel, runs: CaseRun[], novelChanges: Map<number, string>): ModelReport {
  const rows: RuleRow[] = []
  const coveredIdx = new Set<number>()
  for (const r of model.rules ?? []) {
    const base = { id: r.id, text: r.text, origin: r.origin, ratified: r.ratified }
    if (r.staged) {
      rows.push({ ...base, status: 'untested', covered: 0, note: 'staged — awaiting your confirmation in model.yaml; not enforced', counterexamples: [] })
      continue
    }
    if (!r.check) {
      rows.push({ ...base, status: 'untested', covered: 0, note: 'uncompiled — no check block yet; ask the agent to compile it', counterexamples: [] })
      continue
    }
    const check = r.check
    const covering: number[] = []
    runs.forEach((run, i) => {
      if (run.scenario !== check.scenario) return
      if (check.where && !evalPred(check.where, run.input)) return
      covering.push(i)
    })
    for (const i of covering) coveredIdx.add(i)
    const cex: Counterexample[] = []
    for (const i of covering) {
      const run = runs[i]
      if (!matchExpect(run.newT, check.expect) && cex.length < CEX_CAP)
        cex.push({ label: run.label, input: run.input, observed: observedOf(run.newT) })
    }
    const violated = covering.some((i) => !matchExpect(runs[i].newT, check.expect))
    rows.push({
      ...base,
      status: covering.length === 0 ? 'untested' : violated ? 'violated' : 'conforms',
      covered: covering.length,
      counterexamples: cex
    })
  }
  // Examples (spec-v2 §1.1): named scenarios that must keep holding. An example covers
  // a case when scenario matches and the input is JSON-equal; its expect is checked
  // against the CURRENT side. Sediment of adjudications, checked forever.
  for (const ex of model.examples ?? []) {
    const covering = runs.filter((r) => r.scenario === ex.scenario && JSON.stringify(r.input) === JSON.stringify(ex.input))
    const cex: Counterexample[] = []
    for (const r of covering)
      if (!matchExpect(r.newT, ex.expect) && cex.length < CEX_CAP) cex.push({ label: r.label, input: r.input, observed: observedOf(r.newT) })
    runs.forEach((r, i) => {
      if (r.scenario === ex.scenario && JSON.stringify(r.input) === JSON.stringify(ex.input)) coveredIdx.add(i)
    })
    rows.push({
      id: `E:${ex.label}`,
      text: ex.label,
      origin: 'example',
      status: covering.length === 0 ? 'untested' : cex.length > 0 ? 'violated' : 'conforms',
      covered: covering.length,
      counterexamples: cex
    })
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) // deterministic report order (spec-v2 §3)
  // Novel: behavior that CHANGED and no rule covers — the only rows that ask.
  const novel: NovelRow[] = []
  runs.forEach((run, i) => {
    if (run.diverged && !coveredIdx.has(i))
      novel.push({ label: run.label, scenario: run.scenario, input: run.input, change: novelChanges.get(i) ?? 'behavior diverged' })
  })
  novel.sort((a, b) => ((a.label ?? '') < (b.label ?? '') ? -1 : 1))
  const nViol = rows.filter((r) => r.status === 'violated').length
  const nUntested = rows.filter((r) => r.status === 'untested').length
  const scope =
    `Checked ${rows.length} rule${rows.length === 1 ? '' : 's'} against ${runs.length} observed case${runs.length === 1 ? '' : 's'}: ` +
    `${rows.filter((r) => r.status === 'conforms').length} conform, ${nViol} violated, ${nUntested} untested. ` +
    `${novel.length} novel change${novel.length === 1 ? '' : 's'} await adjudication. ` +
    'Conformance counts observed cases only — it is not proof over all inputs.'
  return { feature: model.feature, rows, novel, scope }
}

// Bug: memory leak + unhandled rejection
function loadConfig(path) {
  const watcher = fs.watch(path, () => {});
  return import(path).then(m => m.default);
}
