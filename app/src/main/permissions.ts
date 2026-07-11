// The permission kernel — the tiered gate under grasp's "the human judges" thesis.
// A tool call is reduced to a CAPABILITY over a concrete target, then matched against
// rules merged from project + user config plus in-memory session grants. Precedence is
// deny > ask > allow > (no opinion → mode default). A deny holds in EVERY mode (auto
// included) and carries the rule + source, so the refusal teaches instead of just
// failing. Prose teaches the agent to ask well; this structure refuses.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export type Capability = 'Read' | 'Write' | 'Exec' | 'Fetch' | 'Tool' | 'Mcp'
export type Effect = 'allow' | 'ask' | 'deny'
export type Scope = 'once' | 'session' | 'project'

export interface PermRule {
  effect: Effect
  capability: Capability
  pattern: string // glob (Read/Write/Fetch) · command prefix (Exec) · tool/server name (Tool/Mcp)
}

export interface PermDecision {
  effect: Effect | 'default' // 'default' = no rule had an opinion; caller applies mode behavior
  capability: Capability
  target: string
  rule?: PermRule
  source?: 'project' | 'user' | 'session'
}

// Which capability a tool exercises, and over what concrete target. The agent's own
// tools map to a small closed set; an unknown tool is gated by name via `Tool`.
export function capabilityOf(tool: string, input: Record<string, unknown>, isMcp: boolean): { capability: Capability; target: string } {
  if (isMcp) return { capability: 'Mcp', target: tool }
  const path = String(input.path ?? input.file ?? input.notebook_path ?? '')
  switch (tool) {
    case 'write_file': case 'edit_file': case 'notebook_edit': case 'ApplyPatch':
      return { capability: 'Write', target: path }
    case 'read_file': case 'list_dir':
      return { capability: 'Read', target: path }
    case 'run_bash': case 'remote_bash':
      return { capability: 'Exec', target: String(input.command ?? input.cmd ?? '') }
    case 'web_fetch':
      return { capability: 'Fetch', target: String(input.url ?? '') }
    default:
      return { capability: 'Tool', target: tool }
  }
}

// glob → anchored RegExp: `**` any incl. `/`, `*` any except `/`, `?` one char.
function globToRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function matches(rule: PermRule, capability: Capability, target: string): boolean {
  if (rule.capability !== capability) return false
  const p = rule.pattern
  if (capability === 'Exec') {
    // command-prefix at a word boundary: `git` matches `git status`, not `github`
    return target === p || target.startsWith(p + ' ')
  }
  if (capability === 'Tool' || capability === 'Mcp') {
    if (p === '*') return true
    if (p.endsWith('__*')) return target.startsWith(p.slice(0, -1)) // server__* prefix
    return target === p
  }
  // Read / Write / Fetch — glob over the full path, or the basename when the pattern is unqualified
  const re = globToRe(p)
  if (re.test(target)) return true
  if (!p.includes('/') && capability !== 'Fetch') return re.test(target.split('/').pop() ?? target)
  return false
}

// ── config: project over user, both merged; parse `Capability(pattern)` strings ──
const CAP_RE = /^(Read|Write|Exec|Fetch|Tool|Mcp)\((.*)\)$/
function parseRules(effect: Effect, list: unknown): PermRule[] {
  if (!Array.isArray(list)) return []
  const out: PermRule[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const m = CAP_RE.exec(item.trim())
    if (m) out.push({ effect, capability: m[1] as Capability, pattern: m[2] })
  }
  return out
}
function loadFile(p: string): PermRule[] {
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'))
    return [...parseRules('deny', j.deny), ...parseRules('ask', j.ask), ...parseRules('allow', j.allow)]
  } catch {
    return [] // malformed → no rules (fail toward asking, never toward silent allow)
  }
}

const userPath = (): string => join(homedir(), '.grasp', 'permissions.json')
const projectPath = (ws: string): string => join(ws, '.grasp', 'permissions.json')

// In-memory session grants — survive the app session, cleared on restart (never persisted).
const sessionGrants: PermRule[] = []

function rulesFor(workspace: string): { rule: PermRule; source: 'project' | 'user' | 'session' }[] {
  return [
    ...sessionGrants.map((rule) => ({ rule, source: 'session' as const })),
    ...loadFile(projectPath(workspace)).map((rule) => ({ rule, source: 'project' as const })),
    ...loadFile(userPath()).map((rule) => ({ rule, source: 'user' as const }))
  ]
}

// The decision. deny > ask > allow; 'default' when nothing matched.
export function decidePermission(workspace: string, tool: string, input: Record<string, unknown>, isMcp: boolean): PermDecision {
  const { capability, target } = capabilityOf(tool, input, isMcp)
  const hits = rulesFor(workspace).filter((r) => matches(r.rule, capability, target))
  for (const effect of ['deny', 'ask', 'allow'] as Effect[]) {
    const hit = hits.find((h) => h.rule.effect === effect)
    if (hit) return { effect, capability, target, rule: hit.rule, source: hit.source }
  }
  return { effect: 'default', capability, target }
}

// The pattern a grant should carry: a full command line generalizes to its first token
// (allow `git`, not `git status --porcelain=v2 …`); paths/urls grant as observed.
export function grantPattern(capability: Capability, target: string): string {
  if (capability === 'Exec') return target.trim().split(/\s+/)[0] || target
  return target
}

// Persist a grant. 'session' = in-memory for this app run; 'project' = written into the
// repo's .grasp/permissions.json so a teammate inherits it through git.
export function grantPermission(workspace: string, capability: Capability, target: string, scope: Scope): { ok: boolean; error?: string } {
  if (scope === 'once') return { ok: true }
  const rule: PermRule = { effect: 'allow', capability, pattern: grantPattern(capability, target) }
  if (scope === 'session') {
    if (!sessionGrants.some((r) => r.capability === rule.capability && r.pattern === rule.pattern)) sessionGrants.push(rule)
    return { ok: true }
  }
  try {
    const p = projectPath(workspace)
    const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {}
    const allow: string[] = Array.isArray(cur.allow) ? cur.allow : []
    const line = `${capability}(${rule.pattern})`
    if (!allow.includes(line)) allow.push(line)
    cur.allow = allow
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(cur, null, 2))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function listPermissions(workspace: string): { project: PermRule[]; user: PermRule[]; session: PermRule[] } {
  return { project: loadFile(projectPath(workspace)), user: loadFile(userPath()), session: [...sessionGrants] }
}
