// Plugins — a distribution unit that bundles skills (and optionally an MCP server) in one
// directory. A plugin lives at ~/.grasp/plugins/<name>/ (user) or <project>/.grasp/plugins/
// (project) and carries a plugin.json manifest (name, description), an optional skills/ dir,
// and an optional .mcp.json (or mcpServers in the manifest). Plugin skills are discovered by
// the skills loader (so use_skill sees them); plugin MCP servers merge into the MCP config.
//
// v1: discovery + skill bundling + a Settings listing. Install-from-marketplace, signing, and
// sandboxing are deferred (a plugin is, for now, a directory you drop into place by hand —
// consistent with how skills and commands already work).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Plugin {
  name: string
  description: string
  source: 'user' | 'project'
  hasSkills: boolean
  mcpCount: number
  dir: string
}

const userPluginsDir = (): string => join(homedir(), '.grasp', 'plugins')
const projectPluginsDir = (workspace: string): string => join(workspace || '.', '.grasp', 'plugins')

function readPluginsDir(dir: string, source: 'user' | 'project'): Plugin[] {
  if (!existsSync(dir)) return []
  const out: Plugin[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const pdir = join(dir, e.name)
    let name = e.name
    let description = ''
    const manifest = join(pdir, 'plugin.json')
    if (existsSync(manifest)) {
      try {
        const m = JSON.parse(readFileSync(manifest, 'utf-8'))
        name = typeof m.name === 'string' ? m.name : name
        description = typeof m.description === 'string' ? m.description : ''
      } catch {
        /* malformed manifest -> fall back to dir name */
      }
    }
    let mcpCount = 0
    const mcpFile = join(pdir, '.mcp.json')
    if (existsSync(mcpFile)) {
      try {
        const c = JSON.parse(readFileSync(mcpFile, 'utf-8'))
        const servers = c?.mcpServers ?? c
        mcpCount = servers && typeof servers === 'object' ? Object.keys(servers).length : 0
      } catch {
        /* malformed -> 0 */
      }
    }
    out.push({ name, description, source, hasSkills: existsSync(join(pdir, 'skills')), mcpCount, dir: pdir })
  }
  return out
}

export function listPlugins(workspace: string): Plugin[] {
  // project plugins override same-named user plugins
  const byName = new Map<string, Plugin>()
  for (const p of [...readPluginsDir(userPluginsDir(), 'user'), ...readPluginsDir(projectPluginsDir(workspace), 'project')]) {
    byName.set(p.name, p)
  }
  return [...byName.values()]
}

// The skills/ dirs of plugins that bundle skills — the skills loader reads these too, so a
// plugin's skills appear via use_skill and the system-prompt listing.
export function pluginSkillRoots(workspace: string): string[] {
  return listPlugins(workspace)
    .filter((p) => p.hasSkills)
    .map((p) => join(p.dir, 'skills'))
}
