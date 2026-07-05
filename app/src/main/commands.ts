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
  for (const c of [...readDir(userDir(), 'user'), ...readDir(projectDir(workspace), 'project')]) byName.set(c.name, c)
  return [...byName.values()]
}
