// Skills — reusable, packaged instructions the agent can load and follow. A skill is a
// markdown file (frontmatter: name, description; body: the instructions) in
// ~/.grasp/skills (user) or <project>/.grasp/skills (project). Thesis-aligned: skills
// orchestrate grasp's observe/diff/fuzz loop — they don't judge, they guide.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
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
  'trace-flow.md': `---
name: trace-flow
description: Show the real dataflow of code — the live call tree with actual values — instead of asserting it works.
---
grasp's Flow shows what code ACTUALLY does when it runs: the call tree, the real values that
flow through it, ending in a neutral question. Use it to SHOW behavior, never to claim correctness.

WHEN YOU WRITE OR CHANGE CODE:
1. Pick a real, exercisable entrypoint — a function that can run for real with a concrete input.
   - Python: module.func (e.g. app.orders.checkout)
   - JS/TS: path/to/file.ts:func (e.g. src/utils/colorUtils.ts:getFontColor)
   Prefer a pure function (logic, no DOM/network). If the target needs deps, they must be installed.
2. Call grasp_trace with that entrypoint and a representative input. The Flow renders the real
   call tree — args → interior calls → return — with observed values and source lines.
3. AFTER an edit, call grasp_trace_diff (same entrypoint + input) to show the A→B behavioral
   change: which frames and values differ, ending in "… — intended?".

RULES:
- Present exactly what the Flow returns. Do NOT say the code "works", is "fixed", or is "correct".
- If grasp reports it could not observe the run (unobservable), say so plainly and why — never
  invent a flow. A tooling gap is not the code's behavior.
- The human adjudicates against business rules only they know. You surface; they judge.`,
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
  } catch {
    /* ignore */
  }
}
