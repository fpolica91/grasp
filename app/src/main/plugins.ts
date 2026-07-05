// Plugins — a distribution unit that bundles skills (and optionally an MCP server) in one
// directory. A plugin lives at ~/.grasp/plugins/<name>/ (user) or <project>/.grasp/plugins/
// (project) and carries a plugin.json manifest (name, description), an optional skills/ dir,
// and an optional .mcp.json (or mcpServers in the manifest). Plugin skills are discovered by
// the skills loader (so use_skill sees them); plugin MCP servers merge into the MCP config.
//
// v1: discovery + skill bundling + a Settings listing + install-from-git. Signing and
// sandboxing remain deferred — install is consent-based (the user provides the URL) and MCP
// tools stay gated by ask-mode, which is the right model for an OSS tool.
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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

type PluginMcpServer = { command: string; args?: string[]; env?: Record<string, string> }

// Read a plugin's bundled MCP servers (.mcp.json: {mcpServers:{...}} or flat). null if none/invalid.
function readPluginMcpServers(pdir: string): Record<string, PluginMcpServer> | null {
  const mcpFile = join(pdir, '.mcp.json')
  if (!existsSync(mcpFile)) return null
  try {
    const c = JSON.parse(readFileSync(mcpFile, 'utf-8'))
    const servers = c?.mcpServers ?? c
    return servers && typeof servers === 'object' ? (servers as Record<string, PluginMcpServer>) : null
  } catch {
    return null
  }
}

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
    const mcpServers = readPluginMcpServers(pdir)
    out.push({
      name,
      description,
      source,
      hasSkills: existsSync(join(pdir, 'skills')),
      mcpCount: mcpServers ? Object.keys(mcpServers).length : 0,
      dir: pdir
    })
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

// Each plugin's bundled MCP servers (for mcp.ts to merge into the MCP config). The consumer
// namespaces keys as `<plugin>__<server>` to avoid collisions across plugins and user config.
export function pluginMcpConfigs(workspace: string): { name: string; dir: string; servers: Record<string, PluginMcpServer> }[] {
  return listPlugins(workspace)
    .map((p) => ({ name: p.name, dir: p.dir, servers: readPluginMcpServers(p.dir) }))
    .filter(
      (p): p is { name: string; dir: string; servers: Record<string, PluginMcpServer> } => p.servers !== null
    )
}

// Install a plugin from a git URL (consent-based — the user pasted the URL, so trust is
// explicit; MCP tools stay gated by ask-mode). Clones --depth 1 into ~/.grasp/plugins/<name>/
// and validates it looks like a grasp plugin. Skills/MCP register on the next turn (the caller
// also calls clearMcpCache so MCP servers pick up immediately).
export function installPlugin(gitUrl: string): { ok: boolean; name?: string; error?: string } {
  const url = gitUrl.trim()
  const name = url.replace(/\.git$/, '').split('/').pop()?.trim() ?? ''
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false, error: 'could not derive a valid plugin name from the URL' }
  const dir = userPluginsDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* may already exist */
  }
  const target = join(dir, name)
  if (existsSync(target)) return { ok: false, error: `a plugin named "${name}" already exists` }
  const r = spawnSync('git', ['clone', '--depth', '1', url, target], { timeout: 60_000 })
  const stderr = (r.stderr ?? '').toString().trim()
  if (r.error || r.status !== 0) {
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup of a partial clone */
    }
    return { ok: false, error: `git clone failed: ${stderr || r.error?.message || 'unknown'}` }
  }
  // validate it's a grasp plugin: at least one of plugin.json / skills/ / .mcp.json
  if (!existsSync(join(target, 'plugin.json')) && !existsSync(join(target, 'skills')) && !existsSync(join(target, '.mcp.json'))) {
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, error: 'cloned, but the repo has no plugin.json, skills/, or .mcp.json — not a grasp plugin' }
  }
  return { ok: true, name }
}

// Remove a user plugin directory by name.
export function uninstallPlugin(name: string): { ok: boolean; error?: string } {
  const target = join(userPluginsDir(), name)
  if (!existsSync(target)) return { ok: false, error: `no plugin named "${name}"` }
  try {
    rmSync(target, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
