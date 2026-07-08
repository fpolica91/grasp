// Test harness — lets an EXTERNAL agent (or script) drive and inspect grasp so the human
// never has to be the test rig. Two transports, one handler set:
//   • HTTP on 127.0.0.1:$GRASP_TEST_PORT (default 43117) — POST /event, POST /tool, POST /turn (a full chat-equivalent agent turn),
//     POST /screenshot, GET /health
//   • a file bridge at <cwd>/.grasp-harness/ — write cmd.json {id, kind, payload},
//     read out-<id>.json — for callers that can only reach the filesystem.
// Screenshots capture the REAL window to a PNG on disk, so "does it look right" is
// checkable without a human. Dev-only: active when the app is unpackaged or GRASP_TEST=1.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { TOOLS } from './backends/tools'
import { runAgent } from './agent'
import type { AgentEvent } from '../shared/types'

interface HarnessCmd {
  id: string
  kind: 'event' | 'tool' | 'turn' | 'screenshot' | 'health'
  payload?: Record<string, unknown>
}

type GetWin = () => BrowserWindow | null

async function handle(cmd: HarnessCmd, getWin: GetWin, dir: string): Promise<Record<string, unknown>> {
  try {
    if (cmd.kind === 'health') return { ok: true, pid: process.pid, tools: TOOLS.map((t) => t.name) }
    if (cmd.kind === 'event') {
      const ev = cmd.payload?.event as AgentEvent | undefined
      if (!ev || typeof (ev as { type?: unknown }).type !== 'string') return { ok: false, error: 'payload.event must be an AgentEvent with a type' }
      const win = getWin()
      if (!win) return { ok: false, error: 'no window' }
      win.webContents.send('agent:event', ev)
      return { ok: true, sent: (ev as { type: string }).type }
    }
    if (cmd.kind === 'tool') {
      const name = String(cmd.payload?.name ?? '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return { ok: false, error: `no tool ${name}`, tools: TOOLS.map((t) => t.name) }
      const events: Record<string, unknown>[] = [] // Emit is wire-loose by design; passthrough
      const workspace = String(cmd.payload?.workspace ?? process.cwd())
      const win = getWin()
      const output = await tool.run((cmd.payload?.input as Record<string, unknown>) ?? {}, {
        workspace,
        emit: (e) => {
          events.push(e)
          win?.webContents.send('agent:event', e) // the UI renders what the tool emitted — same path as a real turn
        }
      })
      return { ok: true, output, events }
    }
    if (cmd.kind === 'turn') {
      // A FULL agent turn — exactly what typing in the chat UI does: same backends, same
      // checkpoints, same tools, same events. The window (if any) renders it live; the
      // caller gets the event stream and final text to validate against.
      const prompt = String(cmd.payload?.prompt ?? '')
      if (!prompt) return { ok: false, error: 'payload.prompt required' }
      const events: Record<string, unknown>[] = []
      const sender = {
        isDestroyed: () => false,
        send: (_ch: string, e: Record<string, unknown>) => {
          events.push(e)
          const w = getWin()
          if (w && !w.isDestroyed()) w.webContents.send('agent:event', e)
        }
      }
      const res = await runAgent(sender, {
        workspace: String(cmd.payload?.workspace ?? process.cwd()),
        prompt,
        history: (cmd.payload?.history as unknown[]) ?? [],
        backend: cmd.payload?.backend as string | undefined,
        model: cmd.payload?.model as string | undefined,
        mode: (cmd.payload?.mode as 'auto' | 'ask' | 'plan') ?? 'auto', // ask-mode approvals would hang a headless caller
        flowAuto: false
      })
      const text = events
        .filter((e) => e.type === 'text' || e.type === 'text_delta')
        .map((e) => String((e as { text?: unknown }).text ?? ''))
        .join('')
        .slice(0, 20000)
      const kept = events.filter((e) => e.type !== 'text_delta' && e.type !== 'thinking_delta').slice(-200)
      return { ok: true, text, events: kept, messages: res.messages }
    }
    if (cmd.kind === 'screenshot') {
      const win = getWin()
      if (!win) return { ok: false, error: 'no window' }
      const img = await win.webContents.capturePage()
      const p = join(dir, `shot-${cmd.id}.png`)
      writeFileSync(p, img.toPNG())
      return { ok: true, path: p }
    }
    return { ok: false, error: `unknown kind ${String(cmd.kind)} (event | tool | turn | screenshot | health)` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function startTestHarness(getWin: GetWin): void {
  const dir = process.env.GRASP_HARNESS_DIR || join(process.cwd(), '.grasp-harness')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }

  // Transport 1: loopback HTTP.
  const port = Number(process.env.GRASP_TEST_PORT) || 43117
  const server = createServer((req, res) => {
    const done = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health') {
      void handle({ id: 'h', kind: 'health' }, getWin, dir).then((r) => done(200, r))
      return
    }
    if (req.method !== 'POST') return done(405, { ok: false, error: 'POST /event | /tool | /screenshot, GET /health' })
    const kind = (req.url ?? '').replace('/', '') as HarnessCmd['kind']
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      let payload: Record<string, unknown> = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        return done(400, { ok: false, error: 'body must be JSON' })
      }
      void handle({ id: String(Date.now()), kind, payload }, getWin, dir).then((r) => done(r.ok ? 200 : 400, r))
    })
  })
  server.on('error', () => {
    /* port taken (second instance) — file bridge still works */
  })
  server.listen(port, '127.0.0.1')

  // Transport 2: file bridge — poll cmd.json, answer as out-<id>.json.
  const cmdPath = join(dir, 'cmd.json')
  setInterval(() => {
    if (!existsSync(cmdPath)) return
    let cmd: HarnessCmd
    try {
      cmd = JSON.parse(readFileSync(cmdPath, 'utf-8')) as HarnessCmd
    } catch {
      return // partially written — next tick
    }
    try {
      rmSync(cmdPath)
    } catch {
      return
    }
    if (!cmd || typeof cmd.id !== 'string') return
    void handle(cmd, getWin, dir).then((r) => {
      try {
        writeFileSync(join(dir, `out-${cmd.id}.json`), JSON.stringify(r, null, 2))
      } catch {
        /* out dir vanished — nothing to do */
      }
    })
  }, 500)
}
