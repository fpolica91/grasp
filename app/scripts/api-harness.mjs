// Headless API harness — compiles the REAL tool registry and invokes it like a backend
// would, asserting emitted events. Run: npm run validate. This exists because typecheck
// alone once passed while a root-outcome divergence rendered as "same flow".
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const OUT = '/tmp/grasp-api-harness'
execSync(`npx tsc src/main/backends/tools.ts src/main/commands.ts --outDir ${OUT} --module commonjs --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck`, { stdio: 'inherit' })
const require_ = createRequire(import.meta.url)
process.env.NODE_PATH = new URL('../node_modules', import.meta.url).pathname
require_('node:module').Module._initPaths()
const { TOOLS } = require_(`${OUT}/main/backends/tools.js`)
const { listCommands } = require_(`${OUT}/main/commands.js`)

const WS = '/tmp/grasp-harness-ws'
mkdirSync(`${WS}/.grasp`, { recursive: true })
mkdirSync(`${WS}/.git`, { recursive: true }) // fixtures are repos; containers own nothing
writeFileSync(`${WS}/.grasp/model.yaml`, `grasp_model_version: 1
feature: tasks
rules:
  - { id: R1, text: editing a deleted task is rejected, origin: ratified, ratified: "2026-07-07",
      check: { scenario: edit_task, where: { op: cmp, path: task.state, rel: "==", value: deleted }, expect: { status: threw, threwType: ValidationError } } }
  - { id: R2, text: only the owner may edit, origin: authored }
  - { id: R3, text: deletes are idempotent, origin: ratified, ratified: "2026-07-08", staged: true }
  - { id: R4, text: archive requires an active task, origin: authored,
      check: { scenario: archive_task, expect: { status: threw } } }
examples:
  - { label: deleted task stays rejected, scenario: edit_task, input: { task: { state: deleted } },
      expect: { status: threw, threwType: ValidationError } }
`)
let failed = 0
const assert = (n, ok) => { if (!ok) { failed++; console.log('FAIL ', n) } else console.log('ok   ', n) }
const tool = (n) => TOOLS.find((t) => t.name === n)
const events = []
const ctx = { workspace: WS, emit: (e) => events.push(e) }
const doc = (status, retRepr, threwType) => ({
  grasp_trace_version: '1', id: 't' + Math.random(), createdAt: 0, entry: 'e', language: 'ts', how: 'harness',
  gitRef: 'x', input: null, status, frames: [], ret: retRepr ? { name: 'return', repr: retRepr } : null,
  threw: threwType ? { type: threwType, message: 'm' } : null, durationMs: 1, stdout: '', stderr: '', unobservable: null
})

let r = await tool('grasp_intro').run({ how: 'hub and spokes', flows: [{ name: 'Provision a device', what: 'hub to phone-home' }], suggestion: 'pick a flow' }, ctx)
const intro = events.find((e) => e.type === 'intro')?.intro
assert('intro renders; rules read from model.yaml by grasp', r.includes('introduction rendered') && intro?.rules.length === 4)
assert('intro rule statuses computed', intro.rules[0].status === 'compiled' && intro.rules[1].status === 'uncompiled' && intro.rules[2].status === 'staged')
assert('intro oversize rejected', (await tool('grasp_intro').run({ how: 'x'.repeat(700), flows: [{ name: 'a', what: 'b' }], suggestion: 's' }, ctx)).includes('1-600'))

writeFileSync(`${WS}/cases.json`, JSON.stringify({ cases: [
  { label: 'edit own deleted task', scenario: 'edit_task', input: { task: { state: 'deleted' } }, old: doc('threw', null, 'ValidationError'), new: doc('threw', null, 'ValidationError') },
  { label: 'edit deleted via share page', scenario: 'edit_task', input: { task: { state: 'deleted' } }, old: doc('threw', null, 'ValidationError'), new: doc('returned', '"oops"') },
  { label: 'create task with long name', scenario: 'create_task', input: { name: 'x' }, old: doc('returned', '"t1"'), new: doc('returned', '"t2"') }
] }))
r = await tool('grasp_fuzz_diff').run({ entry: 'tasks', cases_file: 'cases.json' }, ctx)
const fuzz = events.find((e) => e.type === 'fuzz_diff').fuzz
const row = (id) => fuzz.report.rows.find((x) => x.id === id)
assert('root-outcome divergence detected on frameless traces', fuzz.diverged === 2 && fuzz.cases[0].diff.rootChange !== null)
assert('R1 violated with labeled counterexample', row('R1').status === 'violated' && row('R1').counterexamples[0].label === 'edit deleted via share page')
assert('R2/R3 visible debt (uncompiled/staged)', row('R2').note.includes('uncompiled') && row('R3').note.includes('staged'))
assert('novel = uncovered divergence only', fuzz.report.novel.length === 1 && fuzz.report.novel[0].label === 'create task with long name')
assert('honesty line present', r.includes('not proof'))
assert('scenario outcomes carried for every case', fuzz.outcomes.length === 3 && fuzz.outcomes.filter((o) => !o.same).length === 2)
const exRow = fuzz.report.rows.find((x) => x.origin === 'example')
assert('example checked as a row (violated by regression)', exRow && exRow.status === 'violated' && exRow.counterexamples.length >= 1)
assert('coverage gap names the uncovered compiled rule', r.includes('COVERAGE GAP') && r.includes('R4') && r.includes('archive_task'))
assert('report rows deterministically ordered', fuzz.report.rows.map((x) => x.id).join(',') === [...fuzz.report.rows.map((x) => x.id)].sort().join(','))

writeFileSync(`${WS}/.grasp/model.yaml`, 'grasp_model_version: 2\nrules: nope')
events.length = 0
r = await tool('grasp_fuzz_diff').run({ entry: 'tasks', cases_file: 'cases.json' }, ctx)
assert('invalid model surfaced, never silent', r.includes('rules were NOT checked') && events.find((e) => e.type === 'fuzz_diff').fuzz.report === null)

// ── container isolation: repo-owned model wins; container-level model is ignored ──
const C = '/tmp/grasp-harness-container'
mkdirSync(`${C}/repoA/.git`, { recursive: true })
mkdirSync(`${C}/repoA/.grasp`, { recursive: true })
mkdirSync(`${C}/.grasp`, { recursive: true })
writeFileSync(`${C}/.grasp/model.yaml`, 'grasp_model_version: 1\nrules:\n  - { id: DECOY, text: container rule must never load, origin: authored }\n')
writeFileSync(`${C}/repoA/.grasp/model.yaml`, 'grasp_model_version: 1\nrules:\n  - { id: OWNED, text: repo-owned rule, origin: authored }\n')
writeFileSync(`${C}/repoA/cases.json`, JSON.stringify({ cases: [{ label: 'x', scenario: 's', input: {}, old: doc('returned', '"a"'), new: doc('returned', '"a"') }] }))
events.length = 0
r = await tool('grasp_fuzz_diff').run({ entry: 'iso', cases_file: 'repoA/cases.json' }, { workspace: C, emit: (e) => events.push(e) })
const isoRep = events.find((e) => e.type === 'fuzz_diff').fuzz.report
assert('isolation: repo-owned model resolved via anchor', isoRep && isoRep.rows.some((x) => x.id === 'OWNED'))
assert('isolation: container model NEVER loads', !isoRep.rows.some((x) => x.id === 'DECOY'))
events.length = 0
r = await tool('grasp_intro').run({ how: 'container of repos', flows: [{ name: 'A', what: 'b' }], suggestion: 's' }, { workspace: C, emit: (e) => events.push(e) })
assert('isolation: intro on container refuses container model', r.includes('CONTAINER') && events.find((e) => e.type === 'intro').intro.rules.length === 0)

const byName = Object.fromEntries(listCommands(WS).map((c) => [c.name, c]))
assert('/start exists, /model argless, /flow targeted', !!byName.start && !/\$ARGUMENTS/.test(byName.model.body) && /\$ARGUMENTS/.test(byName.flow.body))

console.log(failed ? `\n${failed} FAILED` : '\nALL API VALIDATIONS PASSED')
process.exit(failed ? 1 : 0)
