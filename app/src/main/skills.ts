// Skills — reusable, packaged instructions the agent can load and follow. A skill is a
// markdown file (frontmatter: name, description; body: the instructions) in
// ~/.grasp/skills (user) or <project>/.grasp/skills (project). Thesis-aligned: skills
// orchestrate grasp's observe/diff/fuzz loop — they don't judge, they guide.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Skill {
  name: string
  description: string
  body: string
  source: 'user' | 'project'
}

const userDir = (): string => join(homedir(), '.grasp', 'skills')
const projectDir = (workspace: string): string => join(workspace || '.', '.grasp', 'skills')

function parse(md: string): { name: string; description: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md)
  if (!m) return { name: '', description: '', body: md.trim() }
  const fm = m[1]
  return {
    name: /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? '',
    description: /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? '',
    body: m[2].trim()
  }
}

function readDir(dir: string, source: 'user' | 'project'): Skill[] {
  if (!existsSync(dir)) return []
  const out: Skill[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const p = parse(readFileSync(join(dir, f), 'utf-8'))
      out.push({ name: p.name || f.replace(/\.md$/, ''), description: p.description, body: p.body, source })
    }
  } catch {
    /* unreadable dir -> skip */
  }
  return out
}

export function listSkills(workspace: string): Skill[] {
  // project skills override user skills of the same name
  const user = readDir(userDir(), 'user')
  const project = readDir(projectDir(workspace), 'project')
  const byName = new Map<string, Skill>()
  for (const s of [...user, ...project]) byName.set(s.name, s)
  return [...byName.values()]
}

export function readSkill(workspace: string, name: string): Skill | null {
  return listSkills(workspace).find((s) => s.name === name) ?? null
}

// Seed a couple of thesis-aligned example skills the first time (never overwrite).
const EXAMPLES: Record<string, string> = {
  'fuzz-diff.md': `---
name: fuzz-diff
description: Did my edit break something? Vary the input space, trace old vs new on each, surface every divergence.
---
A single input proves nothing about the inputs you did not try. A change that is catastrophic on an
input you skipped reads as \"same flow\". So to answer \"did my edit break something\", do NOT trace one
input — vary the input space and surface EVERY input where old and new diverge. You are the compiler;
you generate the spread. grasp diffs the pairs and renders only the divergences, with a scope statement.

## 1. Generate a spread of inputs (deterministic)
From the entrypoint's schema / types / the shape of your change, build a representative matrix — seed
it so it is reproducible (same code + same seed => same inputs):
- a valid/typical input
- each field at its BOUNDARY: min-1, min, max, max+1, empty string, 0, negative, huge
- WRONG TYPE per field (string where number expected, null, array, object)
- MISSING each required field; extra unexpected fields
- known adversarial shapes for the domain (e.g. \"a@\", unicode, injection-looking strings)
Aim for coverage of the branches your change touches, not volume.

## 2. Trace old vs new on each input
For every input, observe the SAME input on the OLD code and the NEW code (trace the new working tree,
then git stash/checkout the old ref and trace again), exactly as in the trace-flow skill. For a sweep
the traces can be LIGHT — you mainly need each run's outcome (root return / thrown) to detect
divergence, so a shallow trace per input is fine; do not produce 300 frames x N.

## 3. Submit
Write a JSON array to a file, one element per input: { \"input\": <the input>, \"old\": <Trace v1 doc>,
\"new\": <Trace v1 doc> }. Call grasp_fuzz_diff with entry and cases_file=<that path>. grasp diffs every
pair, keeps only the inputs where behavior changed, and renders them with an honest scope line
(N tried, K diverged).

## 4. Honesty (non-negotiable)
- grasp reports \"varied N inputs; K diverged\" — it NEVER says the change is safe. K=0 means \"no
  divergence across the N you tried\", not \"correct\". Say so.
- Every value is a real observation; never invent an input's result.
- If you could not run a case, drop it (do not fabricate a pass); the count reflects only what ran.
- The divergences are facts ending in neutral questions. The human adjudicates.`,
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
- Install deps if needed (npm/pnpm install, pip install -e ., go mod download, ...).
- Identify the exact code you changed (git diff). You trace THAT, not the whole app.

## 2. Observe a real run
Run the real code and capture the call flow of the part you changed: every function entered, the
ACTUAL argument values, what it returned or threw, in call-tree order. Use whatever fits the stack:
Python sys.settrace; JS/TS a loader/require hook or added trace calls under node; Go go/ast rewrite
or delve; anything else — instrument it, or parse a real test run. Reference starting-point tracers
are seeded at ~/.grasp/skills/tracers (py_trace.py, js_trace/, go_trace/): COPY and ADAPT them. If one
does not fit this repo, change it or write your own. Do not ask grasp to trace for you.

## 3. Keep it legible
Scope to the code you changed. When it calls into a library/framework you usually want the boundary,
not the internals — mark plumbing frames meaningful:false so grasp collapses them by default. A
400-frame dump of a library is a failure; the reader must see YOUR logic first.

## 4. Submit
- Single flow: call grasp_flow with the Trace v1 JSON.
- A to B change: trace the NEW code and the OLD code (git stash/checkout the old ref) with the SAME
  input, then call grasp_flow_diff with both.

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
Surface the facts; ask whether the varied behavior is intended. Never label it pass/fail.`
}

export function ensureDefaultSkills(): void {
  const dir = userDir()
  try {
    mkdirSync(dir, { recursive: true })
    const hasAny = readdirSync(dir).some((f) => f.endsWith('.md'))
    if (!hasAny) for (const [f, body] of Object.entries(EXAMPLES)) writeFileSync(join(dir, f), body)
    // Seed the reference tracers as ADAPTABLE assets the agent can copy (grasp never runs them).
    const dest = join(dir, 'tracers')
    if (!existsSync(dest)) {
      const srcDir = existsSync(pathResolve(process.cwd(), 'resources', 'tracers'))
        ? pathResolve(process.cwd(), 'resources', 'tracers')
        : join(process.resourcesPath ?? process.cwd(), 'tracers')
      try {
        cpSync(srcDir, dest, { recursive: true, filter: (p) => !p.includes('node_modules') })
      } catch { /* reference tracers are optional */ }
    }
  } catch {
    /* ignore */
  }
}
