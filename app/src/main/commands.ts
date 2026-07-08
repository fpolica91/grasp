// User-authored slash commands — a .md file (frontmatter: name, description, skills) whose
// body is a prompt template. Drop one in ~/.grasp/commands (user) or <project>/.grasp/commands
// (project) and it shows up as /<name> in the command palette. The body may use $ARGUMENTS /
// $1 / $2 placeholders (substituted by the renderer when run). A `skills:` key auto-loads a
// skill — commands and skills are unified (a command is a deterministic alias for a
// model-decidable skill). Mirrors the skills loader.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SlashCommand } from '../shared/types'

// Built-in commands — always present so typing "/" is never an empty menu. A user or
// project command with the same name overrides a builtin (byName insertion order).
const BUILTINS: SlashCommand[] = [
  {
    name: 'start',
    description: 'First introduction: grasp meets this repo — how it runs, what can be traced, which rules your docs already state',
    body:
      'Introduce this workspace to me as if I have never used grasp. Do tier 0 of the load-repo ' +
      'skill (read the recipe if present, else only the repo docs and manifests — run nothing). ' +
      'If no behavior model exists, bootstrap it per the behavior-model skill init: harvest stated ' +
      'always/nevers from the repo docs, witness-test them, stage them for my signature. Then tell ' +
      'me, in plain words and at most a dozen lines: how this repo runs, the 3-6 features you could ' +
      'show me the flow of (by name, not symbols), the staged rules awaiting my yes/no, and the one ' +
      'thing you suggest I do next. Then SUBMIT the introduction via grasp_intro (how / flows / ' +
      'suggestion — grasp adds the rules from model.yaml itself) and keep chat to a single line. ' +
      'No jargon, no rungs, no protocol talk.',
    skills: 'load-repo',
    source: 'user'
  },
  {
    name: 'model',
    description: 'Bootstrap or review the behavior model — harvest candidate always/nevers from the repo own docs, staged for your signature',
    body:
      'If .grasp/model.yaml does not exist: survey the repo own documentation (README, agent-instruction ' +
      'files, contributor docs) for stated behavioral always/nevers, apply the witness test — keep only ' +
      'rules a RUN could show being violated; exclude static style rules — and write each candidate as a ' +
      'rule with staged: true, origin: authored, and the doc citation in evidence. Present the slate: I ' +
      'confirm each by deleting its staged flag, or delete the rule. Author nothing from your own ' +
      'judgment. If the model exists: report every rule by status (staged / uncompiled / compiled), what ' +
      'awaits my signature, and which compiled rules were last checked when.',
    skills: 'behavior-model',
    source: 'user'
  },
  {
    name: 'flow',
    description: 'Trace an entrypoint for real and render the Flow',
    body:
      'Show the real Flow of: $ARGUMENTS. The target may be a FEATURE NAME or a symbol \u2014 resolving ' +
      'it is your job, not the human\u2019s: check the entrypoint map in .grasp/RECIPE.md, then search ' +
      'the source. If the logic lives in a DOM-coupled closure or component, extract it into a plain ' +
      'callable module first and trace THAT. State the resolution you made. Ask only if several ' +
      'candidates genuinely match; never fabricate a frame for a target that does not exist. Trace on ' +
      'a representative input, submit via grasp_flow, mark plumbing frames meaningful:false, and ' +
      'record the feature \u2192 symbol mapping in the recipe.',
    skills: 'trace-flow',
    source: 'user'
  },
  {
    name: 'fuzz',
    description: 'Differential fuzz old vs new across the input space, with a checked claim',
    body:
      'Differential-fuzz the change at $ARGUMENTS (a feature name or a symbol \u2014 resolve it via the ' +
      'recipe entrypoint map or the source first; extract a plain callable if it is DOM-coupled): ' +
      'generate a deterministic input spread, trace old ' +
      'and new per input, then submit {cases, claim: {where, effect}, axes} via grasp_fuzz_diff — ' +
      'propose the boundary from the diverged inputs and STRADDLE it to falsify yourself first.',
    skills: 'fuzz-diff',
    source: 'user'
  }
]

const userDir = (): string => join(homedir(), '.grasp', 'commands')
const projectDir = (workspace: string): string => join(workspace || '.', '.grasp', 'commands')

function parse(md: string, fallbackName: string): Omit<SlashCommand, 'source'> {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md)
  if (!m) return { name: fallbackName, description: '', body: md.trim() }
  const fm = m[1]
  const field = (k: string): string | undefined => {
    const v = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim()
    return v || undefined
  }
  return {
    name: field('name') ?? fallbackName,
    description: field('description') ?? '',
    body: m[2].trim(),
    skills: field('skills') ?? field('skill')
  }
}

function readDir(dir: string, source: 'user' | 'project'): SlashCommand[] {
  if (!existsSync(dir)) return []
  const out: SlashCommand[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      out.push({ ...parse(readFileSync(join(dir, f), 'utf-8'), f.replace(/\.md$/, '')), source })
    }
  } catch {
    /* unreadable dir -> skip */
  }
  return out
}

export function listCommands(workspace: string): SlashCommand[] {
  // project commands override same-named user commands
  const byName = new Map<string, SlashCommand>()
  for (const c of [...BUILTINS, ...readDir(userDir(), 'user'), ...readDir(projectDir(workspace), 'project')]) byName.set(c.name, c)
  return [...byName.values()]
}
