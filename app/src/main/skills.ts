// Skills — reusable, packaged instructions the agent can load and follow. Thesis-aligned:
// skills orchestrate grasp's observe/diff/fuzz loop — they don't judge, they guide.
//
// A skill is EITHER:
//   • a directory  <root>/<name>/SKILL.md   (preferred — may bundle references/, scripts/)
//   • a flat file  <root>/<name>.md         (legacy/simple skills)
// discovered in ~/.grasp/skills (user) or <project>/.grasp/skills (project). Project skills
// override same-named user skills. Directory skills carry a `baseDir` so a body instruction
// like "read references/foo.md" resolves to an unambiguous absolute path (progressive
// disclosure: metadata is always in context; the body loads on use_skill; bundled files
// load only on explicit read_file).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pluginSkillRoots } from './plugins'

export interface Skill {
  name: string
  description: string // full description; the first ~250 chars are the model's trigger surface
  whenToUse?: string
  body: string
  source: 'user' | 'project'
  baseDir?: string // the skill's own directory (directory skills) — enables 'read references/x.md'
  warning?: string // surfaced in the listing (e.g. description too long); never blocks loading
  enabled: boolean // false = the user disabled it in Settings -> hidden from the agent
}

const MAX_DESCRIPTION = 1024 // over this the trigger surface overflows the context budget

const userDir = (): string => join(homedir(), '.grasp', 'skills')
const projectDir = (workspace: string): string => join(workspace || '.', '.grasp', 'skills')

function parse(md: string): { name: string; description: string; whenToUse?: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md)
  if (!m) return { name: '', description: '', body: md.trim() }
  const fm = m[1]
  const field = (k: string): string | undefined => {
    const v = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim()
    return v || undefined
  }
  return {
    name: field('name') ?? '',
    description: field('description') ?? '',
    whenToUse: field('when_to_use'),
    body: m[2].trim()
  }
}

function makeSkill(
  name: string,
  parsed: { description: string; whenToUse?: string; body: string },
  source: 'user' | 'project',
  baseDir?: string
): Skill {
  const skill: Skill = { name, description: parsed.description, whenToUse: parsed.whenToUse, body: parsed.body, source, enabled: true }
  if (baseDir) skill.baseDir = baseDir
  if (parsed.description.length > MAX_DESCRIPTION)
    skill.warning = `description is ${parsed.description.length} chars (> ${MAX_DESCRIPTION}); trim it so the trigger fits the context budget`
  return skill
}

// Scan one skills root: directory skills (<name>/SKILL.md) win over a same-named flat file.
function readDir(dir: string, source: 'user' | 'project'): Skill[] {
  if (!existsSync(dir)) return []
  const out: Skill[] = []
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const skillMd = join(dir, e.name, 'SKILL.md')
        if (existsSync(skillMd)) {
          const p = parse(readFileSync(skillMd, 'utf-8'))
          out.push(makeSkill(p.name || e.name, p, source, join(dir, e.name)))
        }
        continue
      }
      if (e.isFile() && e.name.endsWith('.md')) {
        const p = parse(readFileSync(join(dir, e.name), 'utf-8'))
        out.push(makeSkill(p.name || e.name.replace(/\.md$/, ''), p, source))
      }
    }
  } catch {
    /* unreadable dir -> skip */
  }
  return out
}

export function listSkills(workspace: string): Skill[] {
  // project skills override same-named user skills; plugin-bundled skills are also discovered
  // (a plugin's skills/ dir is just another skills root).
  const disabled = readDisabled()
  const user = readDir(userDir(), 'user')
  const project = readDir(projectDir(workspace), 'project')
  const fromPlugins = pluginSkillRoots(workspace).flatMap((root) => readDir(root, 'user'))
  const byName = new Map<string, Skill>()
  for (const s of [...user, ...project, ...fromPlugins]) byName.set(s.name, s)
  return [...byName.values()].map((s) => (disabled.has(s.name) ? { ...s, enabled: false } : s))
}

export function readSkill(workspace: string, name: string): Skill | null {
  const s = listSkills(workspace).find((x) => x.name === name) ?? null
  return s && s.enabled ? s : null // a disabled skill is not loadable by the agent
}

// Persisted disabled set (~/.grasp/skills-disabled.json) — the user toggles it in Settings.
const disabledFile = (): string => join(homedir(), '.grasp', 'skills-disabled.json')
function readDisabled(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(disabledFile(), 'utf-8'))
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
export function setSkillEnabled(name: string, enabled: boolean): void {
  const set = readDisabled()
  if (enabled) set.delete(name)
  else set.add(name)
  try {
    writeFileSync(disabledFile(), JSON.stringify([...set], null, 2))
  } catch {
    /* unreadable / unwritable -> ignore (the in-memory list still reflects this session) */
  }
}

// Progressive-disclosure layer 1: skill metadata (name + first ~250 chars of description) is
// always in the system prompt under an 8 KB cap, so the model can decide to invoke one. The
// body loads only on use_skill; bundled reference files load only on explicit read_file.
const SKILLS_BUDGET = 8000
export function skillsListing(workspace: string): string {
  const list = listSkills(workspace).filter((s) => s.enabled) // disabled skills stay out of the system prompt
  if (!list.length) return ''
  const lines: string[] = []
  let used = 0
  for (const s of list) {
    const desc = (s.description || '').slice(0, 250)
    const line = `- ${s.name}: ${desc}`
    if (used + line.length + 1 > SKILLS_BUDGET) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length
    ? `\n\n# Available skills (call use_skill by name to load a skill's full instructions)\n${lines.join('\n')}`
    : ''
}

// Seed a couple of thesis-aligned example skills the first time (never overwrite).
const EXAMPLES: Record<string, string> = {
  'behavior-model.md': `---
name: behavior-model
description: The workspace behavior model (.grasp/model.yaml) — compile human rules into checkable form, stage ratifications from adjudicated behavior, and surface contradictions BEFORE editing. Use whenever a model exists, when the human states an always/never, or after they answer "intended".
---
The model is the HUMAN's file: their always/nevers, durable. You never author a rule on
your own judgment; you compile, stage, and check. grasp reads the model and replays the
human's judgments against observed cases — "violated" is their word, cached, never yours.

## 0. Init — bootstrapping on first contact (no model file yet)
Candidates come from HUMAN text only: the repo's own docs (README, agent-instruction and
contributor files) already state always/nevers the team signed. Harvest those — never your
own judgment. Apply the WITNESS TEST to each: could a run show this rule being violated?
"Privileged operations require an authorization check" — yes, a scenario can witness it.
"Never use type casts" — no, that lives in source text; it belongs to a linter, not the
model. Write each surviving candidate as a rule with staged: true, origin: authored, and
the doc citation in evidence. Present the slate; the human designates by deleting staged
flags. An unconfirmed slate enforces nothing.

## Ownership (non-negotiable)
Grasp artifacts — model.yaml, RECIPE.md, .grasp/tmp/ — live at the OWNING REPO's root: the
nearest git root of the code in question. A workspace may be a CONTAINER of several repos;
a container owns NOTHING — never create .grasp/ there. When the workspace is a container,
say so and operate per-repo.

## Shape (.grasp/model.yaml at the owning repo root)
grasp_model_version: 1; optional feature; optional states (name -> list of values);
rules (id, text, origin: authored|ratified, ratified date, optional staged, optional
check); examples (label, scenario, input, expect). A rule's check block: { scenario,
where?: <claim-DSL predicate over the case input>, expect: { status: returned|threw,
threwType?, returns? } }.

## 1. Compile (human text -> check block)
When a rule has text but no check, PROPOSE the compilation: pick the scenario name it
quantifies over, the where-predicate, and the expect in the OBSERVED vocabulary — a word
like "rejected" compiles to what the code actually does (a throw of a specific type, a
return of a specific shape), discovered by running, never assumed. Show the human the
proposed block; they confirm by keeping it. An uncompiled rule reports as untested debt.

## 2. Label every fuzz case
Every case you submit carries label (domain language: "edit a deleted task") and scenario
(the name rules quantify over). Unlabeled cases can never satisfy or violate a rule —
they only ever appear as novel.

## 3. Stage ratifications — never write judgments directly
When the human answers "intended" to a novel behavior, append the rule to model.yaml with
origin: ratified, the date, the evidence line, AND staged: true. A staged rule is not
enforced; the human confirms by deleting the staged flag (or deletes the rule). Their
file, their signature.

## 4. Contradiction comes FIRST
Before editing code, if the request contradicts a rule in the model, STOP and surface it:
quote the rule, its origin and date, and ask whether to amend it. Never write code that
knowingly violates a ratified rule without the human choosing the amendment.

## 5. Honesty
The model is checked by grasp against observed cases only — never claim a rule is proven
or impossible to break. Conformance is N observed cases, stated as such.

## 6. When a rule is VIOLATED — repair first, amend only by instruction
Default action: repair the code to satisfy the rule and re-verify. Amending the rule is
the human's move — do it only when they say the rule no longer reflects their intent, and
even then stage the amended text for their confirmation. Never do both silently; never
leave a violation unaddressed in your summary.`,
  'load-repo.md': `---
name: load-repo
description: Open a workspace and make it observable ON DEMAND — read the recipe, pay the compilation tax lazily, cache what you learned in .grasp/RECIPE.md. Use at session start on any repo, and whenever a grasp_* tool needs a rung the recipe has not reached.
---
"Load the codebase" does NOT mean "read the codebase". You are the compiler: the repo becomes
context through OBSERVATION, and the first trace is the map — after tier 0, read only the files
that appear in observed frames. The cost of making a repo observable (the compilation tax) is paid
in installments, cached in .grasp/RECIPE.md, and never paid twice — the recipe travels with the
repo, so a teammate inherits it through git, and a repo may even ship one pre-written.

## The observability ladder
1 runnable -> 2 traceable -> 3 diffable -> 4 fuzzable -> 5 characterizable.
Each rung has its own tax. Climb ONLY to the rung the current task demands.

## Tier 0 — open (always; zero execution)
- Read .grasp/RECIPE.md if present. It is a cached CLAIM, not a fact: trust per rung, and verify
  the rung you are about to use with ONE cheap probe — never a full re-derivation.
- Else read ONLY: the repo's own docs (README, agent-instruction files such as AGENTS.md /
  CLAUDE.md) and its package/build manifests and dev-environment configs. No source files.
  Run nothing.
- Note the rungs claimed vs verified. A rung is VERIFIED only by a probe that actually ran
  this session; manifest/docs evidence makes a rung CLAIMED, never verified. Stop until a
  task demands a rung.
- Report the behavior model: absent, or rule counts by status (staged / uncompiled /
  compiled) — the semantic memory next to the recipe's operational memory.
- Leftover trace artifacts (.grasp-*.json, .grasp/tmp/*) are evidence a target was once
  traceable: note the entrypoint name in the map as a claim (from the filename), do NOT
  read the payloads at tier 0.

## Tier 1 — baseline (first time a flow is demanded; time-boxed)
Goal: rung 2, traceable. Install deps if missing, then observe per the trace-flow skill:
the RUNNING APP on a real input first; a repo-runner probe only as a declared fallback.
Capture one Trace v1, submit via grasp_flow.
- From here on, read only files that appear in observed frames — the trace is the map.
- Failure = record the rung reached and the exact blocker in the recipe, and submit
  status:"unobservable" with the reason. Never fabricate a frame.

## Tier 2 — on demand (paid the moment a tool asks)
- diffable (grasp_flow_diff): pin the clock, seed RNG, fix hash seeds, refuse network; prove
  same input => same flow twice before diffing. Nondeterminism turns real divergence into noise.
- fuzzable (grasp_fuzz_diff): parameterize the input surface; record the varied axes AND what is
  held constant, and submit them as axes — grasp verifies both against the cases.
- characterizable: only after observed divergence — propose the boundary, generate cases
  STRADDLING it to falsify yourself, submit claim {where, effect} for grasp to check
  (see the fuzz-diff skill).

## Recipe discipline (.grasp/RECIPE.md at the OWNING REPO root — a container workspace owns nothing; grasp never reads or executes it)
- Update after EVERY rung change, success or failure, with the exact commands as evidence.
  Write each fact THE MOMENT it is proven — never queue the recipe as a final step. An
  interrupted turn loses everything queued behind it; the recipe is the one artifact that
  must survive any death.
- Record per rung: how (commands), pins (clock/seed/net), input axes, blockers.
- Maintain an ENTRYPOINT MAP (feature name \u2192 file.ts:fn), grown every time a target is
  resolved or extracted. The human names features; resolving them to symbols is your job \u2014
  the map is what makes a warm /flow <feature> instant.
- SCRATCH DISCIPLINE: working files (trace JSON, cases files, extraction harnesses) go in
  .grasp/tmp/, never the repo root. On first recipe write, also create .grasp/.gitignore
  containing three lines: *  then  !.gitignore  then  !RECIPE.md — the recipe travels with
  the repo (a teammate inherits the paid tax) while payloads never pollute the user's
  history via checkpoint commits.
- A recipe that breaks right after an edit is a FINDING — the edit changed how the app boots.
  Surface it; do not silently re-derive.
- The recipe caches METHOD, not doctrine. If the cached method sits on a LOWER rung of the
  observation ladder than the skill now prefers (e.g. a runner probe where the RUNNING APP
  could be driven), treat the method as STALE: attempt the higher rung once, and record
  whichever outcome — success or the concrete blocker — as the new cached method.
- ENVIRONMENT PINS: when an install or build behaves impossibly (deps declared but never
  installed, tools missing that should exist), suspect the GLOBAL environment before the repo —
  inspect the toolchain's own global configuration (omit/production modes, registry and proxy
  overrides) — and record the finding and its exact workaround as a pin in the recipe so it is
  never re-derived.
- NEVER delete the repo's lockfile or other files to "fix" your own failed harness attempts:
  every turn starts from a git checkpoint, so restore clobbered files with git checkout --
  <file> and change approach instead.

## Budget
Every rung is time-boxed. Blowing the box = stop, record the blocker in the recipe, ask. The tax
is paid in installments, never as a lump. No verdicts anywhere: rungs, probes and recipes are
facts; "— intended?" belongs to the human.`,
  'fuzz-diff.md': `---
name: fuzz-diff
description: Did my edit break something? Vary the input space, trace old vs new on each, surface every divergence — then characterize it as a claim grasp checks.
---
A single input proves nothing about the inputs you did not try. A change that is catastrophic on an
input you skipped reads as "same flow". So to answer "did my edit break something", do NOT trace one
input — vary the input space and surface EVERY input where old and new diverge. You are the compiler;
you generate the spread. grasp diffs the pairs itself and renders only the divergences, with a scope
statement — and, if you propose one, a CHECKED claim of where/how behavior changed.

## 1. Generate a spread of inputs (deterministic)
From the entrypoint's schema / types / the shape of your change, build a representative matrix — seed
it so it is reproducible (same code + same seed => same inputs). NAME each case: label (domain
language, e.g. "edit a deleted task") and scenario (the name the behavior model's rules quantify
over — see the behavior-model skill). If .grasp/model.yaml declares states, they are your axes:
- a valid/typical input
- each field at its BOUNDARY: min-1, min, max, max+1, empty string, 0, negative, huge
- WRONG TYPE per field (string where number expected, null, array, object)
- MISSING each required field; extra unexpected fields
- known adversarial shapes for the domain (e.g. "a@", unicode, injection-looking strings)
Aim for coverage of the branches your change touches, not volume. Record which fields you varied
(and over what range) and which you deliberately held constant — you will submit that as axes.

## 2. Trace old vs new on each input
For every input, observe the SAME input on the OLD code and the NEW code (trace the new working tree,
then git stash/checkout the old ref and trace again), exactly as in the trace-flow skill. For a sweep
the traces can be LIGHT — you mainly need each run's outcome (root return / thrown) to detect
divergence, so a shallow trace per input is fine; do not produce 300 frames x N. If a case could not
be observed on one side, submit it as status "unobservable" — grasp drops the pair honestly rather
than rendering a phantom change.

## 3. Submit
Write a JSON file under .grasp/tmp/ (scratch, gitignored — never the repo root): either a bare array of { "input": ..., "old": <Trace v1>, "new": <Trace v1> }, or
(preferred once you see divergence) an object:
{ "cases": [...],
  "claim": { "where": <Pred>, "effect": { "old": { "status": "threw", "threwType": "ValueError" },
                                          "new": { "status": "returned", "returns": "0.00" } } },
  "axes": { "varied": [{ "path": "credit", "note": "[0, 500]" }], "held": [{ "path": "currency" }] } }
Call grasp_fuzz_diff with entry and cases_file. grasp diffs every pair itself, keeps only real
divergences, verifies the axes against the cases, and CHECKS the claim.

## 4. Characterize the divergence (claim only what you can defend)
"K of N diverged" is a sample; the reviewer thinks in boundaries. From the diverged inputs, propose
the BOUNDARY as a tiny predicate — ops: cmp {path, rel, value}, cmpf {path, rel, other} (field vs
field, e.g. credit > subtotal), and/or {args}, not {arg}, has {path},
type {path, is}, len {path, rel, value}; dot-paths into the input; max 24 nodes — plus the
CONSEQUENCE as an effect pattern over the old/new root outcomes. Then try to BREAK your own claim:
generate extra cases STRADDLING the boundary (just inside, just outside), re-trace them, and submit
cases + claim together. grasp cross-tabulates the claim per case against the divergence IT computed
and renders exactly one of:
- consistent — matched every observed case (corroboration on N cases, not proof)
- mismatched — counterexamples shown as facts
- untested — no observed case on one side of the boundary: no straddle, no evidence
- enumeration — the predicate is ~as big as the divergence list; it compresses nothing
Submitting no claim is honest. Submitting an unchecked claim is impossible.

## 5. Honesty (non-negotiable)
- grasp reports "varied N inputs; K diverged" — it NEVER says the change is safe. K=0 means "no
  divergence across the N you tried", not "correct". Say so.
- Every value is a real observation; never invent an input's result.
- If you could not run a case, submit it unobservable or drop it (never fabricate a pass); the
  count reflects only what ran on both sides.
- The divergences and the checked claim are facts ending in neutral questions. The human adjudicates.`,
  'trace-flow.md': `---
name: trace-flow
description: Show a codebase's real behavior as the interactive Flow — you observe and submit nodes; grasp renders. Never assert "works".
---
grasp does NOT run the target codebase — YOU do. You are the compiler: you make any repo
observable, capture what its code really does, and submit it as nodes. grasp validates and
renders the Flow, ending in a neutral question. Never say a change \"works\" or is \"correct\".

## 1. Preload — learn how THIS repo runs
- Read README.md, AGENTS.md, CLAUDE.md and the manifests (package.json, pyproject.toml, go.mod,
  Makefile) to find: the entrypoint, how it is run/tested, and its dependencies.
- Install deps if needed, using the repo's own package manager as its manifests declare.
- Identify the exact code you changed (git diff). You trace THAT, not the whole app.
- The requested target may be a FEATURE NAME, not a symbol \u2014 the human has intent-level
  visibility, not file-level. Resolve it yourself: the entrypoint map in .grasp/RECIPE.md \u2192
  grep the source \u2192 if the logic is a DOM-coupled closure, extract it into a plain callable
  and trace that — extraction is a REFACTOR, not a copy: the original call site must end up
  importing the extracted function, so the observed code is the shipped code (a parallel copy
  drifts and proves nothing). STATE the resolution you made. Ask only when several candidates genuinely
  match; never trace a guess, never report \u201cnot found\u201d while the feature plainly exists.

## 2. Observe a real run — the APP first; a harness only as a DECLARED fallback
There is no tracer to reuse and no default harness. The question is always "what does the
APPLICATION do" — so observe the application. Take the FIRST rung that answers:

a. RUN THE APP AS THE HUMAN WOULD. The repo already says how — its manifests, task-runner
   configs, dev-environment definitions, and contributor docs DECLARE the run method; discover
   it, never assume a tool. Drive the REAL feature surface — the route, the URL, the endpoint,
   the CLI invocation — and attach via the runtime's NATIVE debug/inspection channel: every
   mainstream runtime ships one, and you know the one for the stack in front of you. A driver
   client for that channel may be installed under .grasp/tmp/, NEVER into the repo. The Flow
   must originate from the RUNNING app.
b. REAL INPUTS ONLY, or disclosed. Prefer an input that already exists in the world: the
   README example, a fixture, seed data, a recorded payload. If you must fabricate one, say
   so in "how" — a synthetic input silently presented as usage is a lie of provenance. And
   fixture values must be DISTINCT per entity: never reuse one constant across different
   fields or objects (a task id equal to a category id reads as a real finding when it is
   only fixture laziness). Distinct ids, realistic variety — a synthetic coincidence is a
   fabricated observation.
c. FALLBACK — DECLARED, and the bar is HIGH. "It would require booting the app" is NOT a
   valid reason: booting the app IS the method, and "headless is hard" is the work, not a
   blocker. Valid reasons only: the logic has no runnable surface at all (a pure library),
   the app needs credentials or hardware you do not have, or ONE real attach attempt was
   made and failed — with the concrete failure recorded in the recipe. Only then host a
   probe in the repo's OWN test runner (a test file it already discovers, or can be pointed
   at) importing the REAL module, and state the reason in "how". If you are configuring a
   transpiler or loader you have already failed: the app or its runner does that.
d. MATCH GRANULARITY TO THE QUESTION. A fuzz case needs only the root outcome; a legible
   tree needs the module boundary; line-level stepping via the native channel only when the
   human drills into a frame.
e. CANARY first: prove the attach/harness on a trivial known action, validate the Trace v1
   shape, THEN observe the target. A canary failure is a blocker — recipe + "unobservable".
f. EMIT Trace v1 DIRECTLY: real parameter names at capture time, parent/depth/seq correct.
   A post-processing reshape script means the probe was wrong — move that logic into it.
g. Runners commonly filter even EXPLICIT paths through their include globs: a probe outside
   them needs a tiny override config in .grasp/tmp/ that extends the repo's own.
h. Everything disposable lives in .grasp/tmp/ (gitignored, incl. driver deps). The RECIPE
   records how to re-derive: run command, attach method, route/input used.

## 3. Keep it legible
Scope to the code you changed. When it calls into a library/framework you usually want the boundary,
not the internals — mark plumbing frames meaningful:false so grasp collapses them by default. A
400-frame dump of a library is a failure; the reader must see YOUR logic first. And values
speak the CODE's language, never the harness's: a Date reprs as its ISO string (Date
"2025-06-27T10:00:00.000Z"), a Map as its entries — never an encoding marker like
{"__date__": true}. If reading a value requires knowing how your probe serialized it,
fix the probe's repr, not the reader. The repr IS the value, EXACTLY: no commentary
("(note: ...)"), no mid-string elision, no styling — a note belongs in "how", never inside
an observed value. Long values: keep the exact string up to the 400-char protocol cap with
a single trailing ellipsis, and carry the full value in json when it serializes. And the
HARNESS itself is plumbing: if your probe wrapper appears as a frame, mark it
meaningful:false — the story's roots are the code's own functions, not your scaffold.

## 4. Submit
- Every trace DECLARES its channel in the document: observation: {channel: "app" |
  "native-hook" | "runner" | "other"}. A "runner" trace must also carry appAttempt —
  {attempted: true, failure: "<the concrete error>"} from a REAL attach attempt, or
  {attempted: false, reason: "no-runnable-surface" | "needs-credentials" |
  "needs-hardware" | "deferred-heavyweight" + path}. grasp REFUSES runner traces without it.
  Before claiming needs-hardware, CHECK for a simulator: repos that drive hardware usually
  ship one (a dev environment, a simulated fleet, a container stack) — its presence makes
  the claim false.
  When the surface exists but is heavyweight for the question (a plan-level flow does not
  justify booting a VM fleet), the honest reason is "deferred-heavyweight" with path set to
  the exact boot command — the human escalates with one word, and the deferral is visible
  in the Flow header instead of hiding inside a false impossibility.
- Single flow: call grasp_flow with the Trace v1 JSON.
- A to B change: trace the NEW code and the OLD code (git stash/checkout the old ref) with the SAME
  input, then call grasp_flow_diff with both.
- Working files go under .grasp/tmp/ (gitignored), never the repo root — a stray
  .grasp-*.json in the root ends up in the user's checkpoint commits.

## 5. Honesty (non-negotiable)
- Every value is a REAL observation. Never invent a frame or a value.
- If you cannot run it (deps fail, no entrypoint, needs a live service): submit status \"unobservable\"
  with a reason. A tooling gap is not the code's behavior.
- No verdicts. End in the neutral question grasp renders; the human adjudicates.

## Trace v1 protocol (the nodes)
JSON object: { grasp_trace_version:\"1\", id, entry, language, how, input|null,
status:\"returned\"|\"threw\"|\"unobservable\", frames:[...], ret|null, threw|null, durationMs, stdout,
stderr, unobservable|null }. Each frame: { id, parent(null|frame id), seq, depth, fn, file, line,
callLine, args:[{name,repr,json}], ret:{name,repr,json}|null, threw:{type,message}|null, durMs,
language, meaningful?:bool }. grasp enforces: version \"1\"; valid status; unobservable needs a reason;
every frame needs id+fn; parent must reference a real frame id. Invalid traces are rejected — fix and resubmit.`,
  'observe-change.md': `---
name: observe-change
description: After editing a function, observe its real behavior and surface the A→B change.
---
When you have edited an existing function:
1. Call grasp_diff on the entrypoint you changed (module.func) with a representative input.
2. Present the observed A→B operand deltas exactly as returned — the values before vs after.
3. End with grasp's neutral question ("… — intended?"). Do NOT assert it "works" or is "fixed".
The human adjudicates against the business rules only they know.`,
  'harden-input.md': `---
name: harden-input
description: Pressure-test a function across inputs to expose edge cases (the new stack trace).
---
To surface edge cases the current input misses:
1. Write a JSON Schema describing the entrypoint's arguments.
2. Call grasp_fuzz on the entrypoint with that schema (walled by default).
3. Report which operands BENT across inputs and which inputs RAISED, each with its reproducing input.
Surface the facts; ask whether the varied behavior is intended. Never label it pass/fail.`,
  'skill-creator.md': `---
name: skill-creator
description: Author a new reusable skill (a directory with SKILL.md + references). Use when the user wants to package a repeatable workflow as a skill.
---
A skill guides the agent through a reusable workflow. It never judges — it orchestrates grasp's
observe/diff/fuzz loop and ends in the neutral question.

## 1. Frontmatter (the trigger surface)
- name: lowercase kebab-case, 1-64 chars (must match the directory or file name).
- description: one plain sentence; the FIRST ~250 chars are what the model matches on — front-load
  the trigger words. Keep the whole description under 1024 chars or it overflows the budget.
- when_to_use: (optional) extra guidance on when to fire.

## 2. Body (the instructions)
Imperative steps. Reference bundled files by relative path ('read references/foo.md') — grasp
appends a "Base directory" so they resolve absolutely. Target < 500 lines; the body loads only on
use_skill, so keep it cheap.

## 3. Bundle reference files (optional, progressive disclosure)
Supporting docs/scripts go under references/ or scripts/ in the skill directory. They load ONLY on
explicit read_file — do not inline long references into the body.

## 4. Create it
write_file the SKILL.md (and any references/) to ~/.grasp/skills/<name>/ (a directory) or
~/.grasp/skills/<name>.md (flat). It appears in Settings -> Skills and via use_skill immediately.

## 5. Honesty (non-negotiable)
Never render a verdict. End any check with the neutral question; the human adjudicates.

## 6. Name capabilities, never tools
Write "the repo's own test runner", "the runtime's native debug channel", "the dev environment
the repo declares" — never product, package-manager, or language names as guidance. A named
tool anchors every future agent to today's ecosystem and rots the moment it moves; capability
phrasing survives. The tracer graveyard is this lesson in code form.`
}

const bodyHash = (s: string): string => createHash('sha256').update(s).digest('hex')

export function ensureDefaultSkills(): void {
  const dir = userDir()
  try {
    mkdirSync(dir, { recursive: true })
    // Seed marker: file -> sha256 of the body last seeded. A default skill UPGRADES in place
    // only while the on-disk file still matches what we seeded (a user edit is never
    // clobbered); a deleted default stays deleted; a directory-form override is respected.
    // Legacy array markers adopt the current file as the baseline (caveat: a pre-marker user
    // edit is indistinguishable from a stale seed and will upgrade on the following boot).
    const markerPath = join(dir, '.seeded.json')
    let marker: Record<string, string> = {}
    try {
      const j = JSON.parse(readFileSync(markerPath, 'utf-8'))
      if (Array.isArray(j)) {
        for (const n of j)
          if (typeof n === 'string') {
            const f = join(dir, n)
            marker[n] = existsSync(f) ? bodyHash(readFileSync(f, 'utf-8')) : ''
          }
      } else if (j && typeof j === 'object') marker = j as Record<string, string>
    } catch {
      /* first run or unreadable marker */
    }
    let changed = false
    for (const [f, body] of Object.entries(EXAMPLES)) {
      const flat = join(dir, f)
      const dirForm = join(dir, f.replace(/\.md$/, ''), 'SKILL.md')
      const want = bodyHash(body)
      if (existsSync(dirForm)) {
        if (marker[f] !== want) { marker[f] = want; changed = true }
        continue // directory-form override — never touched
      }
      if (!existsSync(flat)) {
        if (!(f in marker)) { writeFileSync(flat, body); marker[f] = want; changed = true } // never offered -> seed
        continue // offered before and deleted -> stays deleted
      }
      const cur = bodyHash(readFileSync(flat, 'utf-8'))
      if (!(f in marker) || marker[f] === '') {
        if (marker[f] !== cur) { marker[f] = cur; changed = true } // adopt existing file as baseline
        continue
      }
      if (marker[f] === cur && cur !== want) { writeFileSync(flat, body); marker[f] = want; changed = true } // pristine seed -> upgrade
    }
    if (changed) writeFileSync(markerPath, JSON.stringify(marker, null, 2))
  } catch {
    /* ignore */
  }
}
