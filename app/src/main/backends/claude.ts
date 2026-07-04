// Claude Code backend — grasp drives the real `claude` CLI (headless stream-json)
// and maps its stream onto the same AgentEvent contract as every other backend.
// Claude Code brings its own tools (Read/Write/Edit/Bash…); grasp's instrument
// still owns the truth: liveSurface re-observes the watched entrypoint after each
// mutating tool, so the dataflow moves while the agent works.
//
// Config: GRASP_CLAUDE_CONFIG_DIR selects the CLAUDE_CONFIG_DIR (e.g. ~/.claude-zai
// routes Claude Code onto a GLM key); unset uses the user's default ~/.claude.
// Headless tool-use requires --dangerously-skip-permissions — named honestly: the
// agent edits the workspace without per-tool prompts, exactly like our GLM loop.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { liveSurface } from './tools'
import type { AgentBackend, BackendTurn, Emit } from './types'

const MUTATING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])

const APPEND_SYSTEM =
  'You are running inside grasp, the post-editor. grasp itself observes the REAL behavior ' +
  'of the code you change (it runs it and shows the human the dataflow change, ending in a ' +
  'question). So: state what you changed factually; do NOT assert a change "works", is ' +
  '"fixed" or "safe" — the observation speaks, the human adjudicates.'

function configDir(): string | undefined {
  if (process.env.GRASP_CLAUDE_CONFIG_DIR) return process.env.GRASP_CLAUDE_CONFIG_DIR
  const zai = join(homedir(), '.claude-zai')
  return existsSync(zai) ? zai : undefined
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ResultBlock = { type: string; tool_use_id?: string; content?: unknown }

function fullText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n')
      : ''
}
function summarize(content: unknown): string {
  return fullText(content).split('\n')[0].slice(0, 120)
}

async function run(turn: BackendTurn, emit: Emit): Promise<{ messages: unknown[] }> {
  // Session continuity: our opaque history for this backend is [{ __claude_session }].
  const prev = turn.history.find(
    (h): h is { __claude_session: string } =>
      !!h && typeof h === 'object' && '__claude_session' in (h as Record<string, unknown>)
  )
  const plan = turn.mode === 'plan'
  const args = ['-p', turn.prompt, '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', APPEND_SYSTEM]
  // Plan mode uses Claude Code's own read-only planning permission mode; otherwise
  // headless tool-use requires skipping the interactive permission prompts.
  if (plan) args.push('--permission-mode', 'plan')
  else args.push('--dangerously-skip-permissions')
  if (turn.model && turn.model !== 'default') args.push('--model', turn.model)
  if (prev) args.push('--resume', prev.__claude_session)

  // Honest: grasp's per-tool Ask gate governs our OWN loops. Claude Code executes its
  // tools under its own permission system, so we don't intercept them — say so.
  if (turn.mode === 'ask') {
    emit({ type: 'text', text: '_Claude Code runs its tools under its own permission system; grasp’s per-tool approval applies to the GLM and OpenAI backends._' })
  }

  const env = { ...process.env }
  const cfg = configDir()
  if (cfg) env.CLAUDE_CONFIG_DIR = cfg

  return new Promise((resolveRun) => {
    const cp = spawn('claude', args, { cwd: turn.workspace, env })
    let sessionId = prev?.__claude_session ?? ''
    let buf = ''
    let stderr = ''
    let sawResult = false
    const mutatingIds = new Set<string>()
    let surfacing = false
    let mutatedSinceSurface = false

    // Re-observe the watched entrypoint as the agent mutates code. Serialized: one
    // observation at a time; a trailing run catches anything that changed meanwhile.
    const maybeSurface = async (): Promise<void> => {
      if (surfacing) return
      surfacing = true
      while (mutatedSinceSurface) {
        mutatedSinceSurface = false
        await liveSurface(turn.workspace, true, emit)
      }
      surfacing = false
    }

    const handle = (line: string): void => {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (typeof ev.session_id === 'string') sessionId = ev.session_id
      // Claude Code tags subagent (Task) activity with parent_tool_use_id — carry it so
      // the UI nests it, exactly like our own subagents.
      const parent = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined
      if (ev.type === 'assistant') {
        const msg = ev.message as { content?: Block[] } | undefined
        for (const b of msg?.content ?? []) {
          if (b.type === 'text' && b.text) emit({ type: 'text', text: b.text, parent })
          else if (b.type === 'tool_use') {
            emit({ type: 'tool_use', id: b.id, name: b.name, input: b.input, parent })
            if (b.name && MUTATING.has(b.name) && b.id) mutatingIds.add(b.id)
          }
        }
      } else if (ev.type === 'user') {
        const msg = ev.message as { content?: ResultBlock[] } | undefined
        const content = Array.isArray(msg?.content) ? msg.content : []
        for (const b of content) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            emit({ type: 'tool_result', id: b.tool_use_id, summary: summarize(b.content), output: fullText(b.content).slice(0, 6000), parent })
            if (mutatingIds.has(b.tool_use_id)) {
              mutatedSinceSurface = true
              void maybeSurface()
            }
          }
        }
      } else if (ev.type === 'result') {
        sawResult = true
        const u = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
        if (u) emit({ type: 'usage', input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 })
        if (ev.is_error) emit({ type: 'error', error: String(ev.result ?? 'claude exited with an error') })
        // In plan mode Claude Code's result is the proposal — hand it to the human.
        else if (plan && typeof ev.result === 'string' && ev.result) emit({ type: 'plan', text: ev.result })
      }
    }

    cp.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) handle(l)
    })
    cp.stderr.on('data', (d) => (stderr += d))
    cp.on('error', (e) => {
      emit({ type: 'error', error: `could not run claude: ${e.message}` })
      resolveRun({ messages: turn.history })
    })
    cp.on('close', async (code) => {
      if (buf.trim()) handle(buf)
      // Trailing surface: catch the final state of the working tree.
      mutatedSinceSurface = mutatingIds.size > 0
      await maybeSurface()
      if (!sawResult && code !== 0) {
        emit({ type: 'error', error: `claude exited ${code}: ${stderr.slice(0, 300)}` })
      } else {
        emit({ type: 'done' })
      }
      resolveRun({ messages: sessionId ? [{ __claude_session: sessionId }] : turn.history })
    })
  })
}

export const claudeBackend: AgentBackend = {
  id: 'claude-code',
  label: 'Claude Code',
  models: ['default', 'opus', 'sonnet', 'haiku'],
  available: () => {
    const r = spawnSync('claude', ['--version'], { timeout: 5000 })
    return r.status === 0 ? { ok: true } : { ok: false, reason: 'claude CLI not found on PATH' }
  },
  run
}
