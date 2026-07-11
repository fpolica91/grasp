// Custom subagent profiles — reusable, per-project specialists the main agent can
// delegate to by name. A profile is <name>/AGENT.md under .grasp/agents (project) or
// ~/.grasp/agents (user); project wins on a name clash, same as skills. Frontmatter
// pins the model, a tool allowlist, and max delegation depth; the body is appended to
// the subagent system prompt. Zero servers — pure local files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AgentProfile {
  name: string
  description: string
  model?: string // pin the subagent to a specific model (else inherits the turn's)
  tools?: string[] // allowlist of tool names (else the full subagent toolset)
  maxDepth?: number // reserved: how deep this profile may itself delegate (default 1)
  system: string // the body — appended to SUBAGENT_SYSTEM
  source: 'project' | 'user'
}

// Minimal frontmatter parse: a leading `---\n…\n---` block of `key: value` lines,
// then the body. Matches the skill loader's shape; no YAML dependency.
function parse(name: string, raw: string, source: 'project' | 'user'): AgentProfile {
  let meta: Record<string, string> = {}
  let body = raw
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw)
  if (m) {
    body = m[2]
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }
  }
  const list = (v?: string): string[] | undefined =>
    v ? v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined
  const depth = meta.maxdepth ? parseInt(meta.maxdepth, 10) : undefined
  return {
    name: meta.name || name,
    description: meta.description || '',
    model: meta.model || undefined,
    tools: list(meta.tools ?? meta['allowed-tools']),
    maxDepth: Number.isFinite(depth) ? depth : undefined,
    system: body.trim(),
    source
  }
}

function scanDir(dir: string, source: 'project' | 'user', into: Map<string, AgentProfile>): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const md = join(dir, name, 'AGENT.md')
    try {
      if (!statSync(join(dir, name)).isDirectory() || !existsSync(md)) continue
      into.set(name, parse(name, readFileSync(md, 'utf-8'), source)) // project scanned last → wins
    } catch {
      /* unreadable profile — skip */
    }
  }
}

// All profiles for a workspace. User first, then project (project overrides on name).
export function listProfiles(workspace: string): AgentProfile[] {
  const map = new Map<string, AgentProfile>()
  scanDir(join(homedir(), '.grasp', 'agents'), 'user', map)
  if (workspace) scanDir(join(workspace, '.grasp', 'agents'), 'project', map)
  return [...map.values()]
}

export function resolveProfile(workspace: string, name: string): AgentProfile | undefined {
  return listProfiles(workspace).find((p) => p.name === name)
}
