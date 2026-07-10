// Lifecycle hooks — run user shell commands at agent-loop events, Devin-style.
// Config: ~/.grasp/hooks.json (user) + <ws>/.grasp/hooks.json (project), each a JSON array.
//   [{ "event": "PreToolUse", "match": "run_bash", "command": "...", "timeout": 5 }, ...]
// Events: UserPromptSubmit | PreToolUse | PostToolUse | Stop (SessionStart/End stubbed for later).
// The command runs in a shell, cwd=workspace, with a JSON context object on stdin:
//   { event, tool?, input?, prompt?, workspace }. stdout (truncated) is surfaced in the chat.
// PreToolUse decides: stdout starting "deny" OR non-zero exit → BLOCK the tool; "allow" → permit.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type HookEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart' | 'SessionEnd'
export interface Hook {
  event: HookEvent
  match?: string // tool-name glob, e.g. 'edit_*' (PreToolUse/PostToolUse only)
  command: string
  timeout?: number // seconds; default 10
}

export interface HookContext {
  workspace: string
  event: HookEvent
  tool?: string
  input?: unknown
  prompt?: string
}
export interface HookResult {
  hook: Hook
  ran: boolean
  stdout: string
  exit: number
  timedOut: boolean
  decision?: 'allow' | 'deny' // PreToolUse only
}

const EVENTS: HookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']

function isHook(x: unknown): x is Hook {
  if (!x || typeof x !== 'object') return false
  const h = x as Record<string, unknown>
  return typeof h.command === 'string' && EVENTS.includes(h.event as HookEvent)
}

export function loadHooks(workspace: string): Hook[] {
  const out: Hook[] = []
  for (const p of [join(homedir(), '.grasp', 'hooks.json'), join(workspace || '.', '.grasp', 'hooks.json')]) {
    if (!existsSync(p)) continue
    try {
      const doc = JSON.parse(readFileSync(p, 'utf-8'))
      if (Array.isArray(doc)) out.push(...doc.filter(isHook))
    } catch {
      /* malformed hooks.json — ignore (honest: no partial behavior) */
    }
  }
  return out
}

// Minimal glob: '*' → any, '?' → one char. Used for the tool-name match only.
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return re.test(name)
}

function runOne(h: Hook, ctx: HookContext): HookResult {
  try {
    const stdin = JSON.stringify({ event: ctx.event, tool: ctx.tool, input: ctx.input, prompt: ctx.prompt, workspace: ctx.workspace })
    const r = spawnSync(h.command, { shell: true, cwd: ctx.workspace || undefined, input: stdin, encoding: 'utf-8', timeout: (h.timeout ?? 10) * 1000 })
    const timedOut = r.status === null && !!(r.signal === 'SIGTERM' || r.error?.message.includes('timed out'))
    const stdout = ((r.stdout ?? '') + (r.stderr && !r.stdout ? r.stderr : '')).trim()
    const exit = r.status ?? -1
    let decision: 'allow' | 'deny' | undefined
    if (ctx.event === 'PreToolUse') {
      if (/^deny\b/i.test(stdout) || exit !== 0) decision = 'deny'
      else if (/^allow\b/i.test(stdout)) decision = 'allow'
    }
    return { hook: h, ran: true, stdout: stdout.slice(0, 2000), exit, timedOut, decision }
  } catch (e) {
    return { hook: h, ran: false, stdout: e instanceof Error ? e.message : String(e), exit: -1, timedOut: false }
  }
}

/** Fire every hook registered for this event (and matching the tool, when applicable). */
export function fireHooks(ctx: HookContext): HookResult[] {
  const hooks = loadHooks(ctx.workspace).filter((h) => {
    if (h.event !== ctx.event) return false
    if (h.match && ctx.tool && !globMatch(h.match, ctx.tool)) return false
    return true
  })
  return hooks.map((h) => runOne(h, ctx))
}

/** True if any PreToolUse hook blocked the tool. Returns the blocking reason if so. */
export function preToolUseGate(workspace: string, tool: string, input: unknown): { blocked: boolean; reason: string } {
  const results = fireHooks({ workspace, event: 'PreToolUse', tool, input })
  const denial = results.find((r) => r.decision === 'deny')
  if (denial) return { blocked: true, reason: denial.stdout.slice(0, 300) || `hook denied ${tool} (exit ${denial.exit})` }
  return { blocked: false, reason: '' }
}

/** A short, human-readable summary of hook outputs (for the chat surface). Empty if nothing ran. */
export function summarizeHookOutputs(results: HookResult[]): string {
  const lines = results.filter((r) => r.stdout).map((r) => {
    const tag = r.timedOut ? ' (timed out)' : r.decision === 'deny' ? ' (denied)' : ''
    return `▸ hook ${r.hook.event}${r.hook.match ? ` [${r.hook.match}]` : ''}${tag}: ${r.stdout.split('\n')[0].slice(0, 160)}`
  })
  return lines.join('\n')
}
