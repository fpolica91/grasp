// MCP (Model Context Protocol) stdio client. Loads servers from .grasp/mcp.json
// (user + project), speaks newline-delimited JSON-RPC 2.0 over each server's stdio,
// and exposes their tools to be merged alongside grasp's built-ins. Secrets in a
// config's `env` block ride in process env — keep .grasp/mcp.json out of git.
//
// Honesty: a server that fails to start or initialize is reported in `start().errors`,
// never silently dropped nor faked. The agent sees the tools that did come up.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pluginMcpConfigs } from '../plugins'

export interface McpServerConfig {
  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http transport (Streamable HTTP, with SSE fallback on the response)
  url?: string
  headers?: Record<string, string>
  transport?: 'stdio' | 'http' | 'sse' // inferred from command/url when absent
  // common
  disabled?: boolean // configured but not started (kept visible in status)
  disabledTools?: string[] // remote tool names to hide after tools/list
}

// Secret references resolved at connect time so tokens never sit in the config file:
//   ${env:VAR}    -> process.env.VAR
//   ${file:/path} -> the file's trimmed contents (e.g. a mounted secret)
function resolveSecrets(v: string): string {
  return v.replace(/\$\{(env|file):([^}]+)\}/g, (_m, kind, ref) => {
    if (kind === 'env') return process.env[ref] ?? ''
    try {
      return readFileSync(ref.trim(), 'utf-8').trim()
    } catch {
      return ''
    }
  })
}
const resolveMap = (m?: Record<string, string>): Record<string, string> | undefined =>
  m ? Object.fromEntries(Object.entries(m).map(([k, val]) => [k, resolveSecrets(val)])) : undefined
export type McpConfig = Record<string, McpServerConfig> // server name -> config

// A tool surfaced by an MCP server. `name` is namespaced (server__tool) so it cannot
// collide with grasp's built-ins or another server's tools.
export interface McpTool {
  server: string
  name: string // namespaced: <server>__<remoteName>
  description: string
  input_schema: object
}

const PROTOCOL_VERSION = '2024-11-05'
const INIT_TIMEOUT_MS = 15000

const userConfigPath = (): string => join(homedir(), '.grasp', 'mcp.json')
const projectConfigPath = (workspace: string): string => join(workspace || '.', '.grasp', 'mcp.json')

// Load + merge mcp configs (user then project; project wins on name clash). Accepts either
// the standard { mcpServers: {...} } envelope or a flat { name: server } object.
// Write/overwrite one server into the USER config (~/.grasp/mcp.json), preserving any existing
// servers and the { mcpServers } envelope. Call clearMcpCache() after so the next turn re-reads.
export function saveMcpServer(name: string, cfg: McpServerConfig): void {
  const p = userConfigPath()
  let doc: { mcpServers?: Record<string, McpServerConfig> } = {}
  if (existsSync(p)) {
    try {
      doc = JSON.parse(readFileSync(p, 'utf-8'))
    } catch {
      doc = {}
    }
  }
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object') doc.mcpServers = {}
  doc.mcpServers[name] = cfg
  try {
    writeFileSync(p, JSON.stringify(doc, null, 2))
  } catch {
    /* unwritable -> ignore (the user can edit the file by hand) */
  }
}

// Remove a server from the USER config (~/.grasp/mcp.json). Returns false if it wasn't there.
export function deleteMcpServer(name: string): boolean {
  const p = userConfigPath()
  if (!existsSync(p)) return false
  let doc: { mcpServers?: Record<string, McpServerConfig> }
  try {
    doc = JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return false
  }
  if (!doc.mcpServers || !(name in doc.mcpServers)) return false
  delete doc.mcpServers[name]
  try {
    writeFileSync(p, JSON.stringify(doc, null, 2))
    return true
  } catch {
    return false
  }
}

export function loadMcpConfig(workspace: string): McpConfig {
  const merged: McpConfig = {}
  // Multi-source: grasp-native (.grasp/mcp.json) + Claude-Code (.mcp.json, .claude/settings.json)
  // + Agents (.agents/mcp.json), user-scope first then project so project wins. Same wire as
  // ZCode's resolver — works with configs authored for any of those agents.
  const ws = workspace || '.'
  const candidates = [
    userConfigPath(),                              // ~/.grasp/mcp.json
    join(homedir(), '.claude', 'settings.json'),   // global Claude Code
    join(homedir(), '.agents', 'mcp.json'),        // global Agents
    projectConfigPath(workspace),                  // <ws>/.grasp/mcp.json
    join(ws, '.mcp.json'),                         // <ws>/.mcp.json (top-level)
    join(ws, '.claude', 'settings.json'),          // <ws> Claude Code
    join(ws, '.agents', 'mcp.json')                // <ws> Agents
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'))
      const servers = data?.mcpServers ?? data
      if (servers && typeof servers === 'object') Object.assign(merged, servers)
    } catch {
      /* malformed file -> ignore it (honest: no partial config) */
    }
  }
  // Plugin-bundled MCP servers: namespace as `<plugin>__<server>` (avoids collisions across
  // plugins and the user config) and resolve ${plugin_root} to the plugin dir, so a plugin can
  // ship a server script and reference it by relative path.
  for (const plug of pluginMcpConfigs(workspace)) {
    const sub = (s: string | undefined): string | undefined =>
      s ? s.split('${plugin_root}').join(plug.dir) : s
    for (const [server, cfg] of Object.entries(plug.servers)) {
      merged[`${plug.name}__${server}`] = {
        command: sub(cfg.command) ?? cfg.command,
        ...(cfg.args ? { args: cfg.args.map((a) => sub(a) ?? a) } : {}),
        ...(cfg.env ? { env: cfg.env } : {})
      }
    }
  }
  for (const k of Object.keys(merged)) {
    const s = merged[k]
    if (!s || (typeof s.command !== 'string' && typeof s.url !== 'string')) delete merged[k]
  }
  return merged
}

// ── Transports: the byte/RPC layer. McpConnection stays wire-agnostic above them. ──
interface McpTransport {
  start(): Promise<void>
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  notify(method: string, params: unknown): void
  stop(): void
}

// stdio: newline-delimited JSON-RPC over a child process's stdin/stdout.
class StdioTransport implements McpTransport {
  private proc: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly name: string, private readonly cfg: McpServerConfig) {}

  async start(): Promise<void> {
    const command = resolveSecrets(this.cfg.command ?? '')
    const args = (this.cfg.args ?? []).map(resolveSecrets)
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(resolveMap(this.cfg.env) ?? {}) }
    })
    this.proc = proc
    proc.stdout?.setEncoding('utf-8')
    proc.stdout?.on('data', (d: string) => this.onData(d))
    proc.on('error', (e) => this.failAll(e.message))
    proc.on('close', () => this.failAll(`mcp server "${this.name}" closed`))
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.proc?.stdin) return Promise.reject(new Error(`mcp server "${this.name}" not started`))
    const id = this.nextId++
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp "${this.name}" ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject, timer })
      this.proc!.stdin!.write(msg + '\n')
    })
  }

  notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  stop(): void {
    this.failAll('stopped')
    try {
      this.proc?.kill()
    } catch {
      /* already gone */
    }
    this.proc = null
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message ?? `mcp ${this.name} error`))
        else p.resolve(msg.result)
      }
    }
  }

  private failAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

// http: MCP Streamable HTTP. Each request is a POST; the response is either a single
// application/json message or a text/event-stream (SSE) carrying it. A Mcp-Session-Id
// returned on initialize is echoed on every later call. Notifications POST and ignore.
class HttpTransport implements McpTransport {
  private nextId = 1
  private sessionId: string | null = null

  constructor(private readonly name: string, private readonly cfg: McpServerConfig) {}

  async start(): Promise<void> {
    /* no persistent connection — the first request (initialize) establishes the session */
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(resolveMap(this.cfg.headers) ?? {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
    }
  }

  private async post(body: unknown, timeoutMs: number): Promise<{ res: Response; text: string }> {
    const url = resolveSecrets(this.cfg.url ?? '')
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await res.text()
    return { res, text }
  }

  // Pull the JSON-RPC message with our id out of a single-json or SSE-framed response.
  private extract(text: string, ctype: string, id: number): { result?: unknown; error?: { message?: string } } {
    const tryParse = (raw: string): { id?: number; result?: unknown; error?: { message?: string } } | null => {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\n\n/)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!data) continue
        const m = tryParse(data)
        if (m && m.id === id) return m
      }
      return { error: { message: 'no matching message in SSE stream' } }
    }
    const m = tryParse(text)
    return m ?? { error: { message: `non-JSON response: ${text.slice(0, 120)}` } }
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++
    const { res, text } = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    if (!res.ok) throw new Error(`mcp "${this.name}" ${method} HTTP ${res.status}: ${text.slice(0, 160)}`)
    const msg = this.extract(text, res.headers.get('content-type') ?? '', id)
    if (msg.error) throw new Error(msg.error.message ?? `mcp ${this.name} error`)
    return msg.result as T
  }

  notify(method: string, params: unknown): void {
    void this.post({ jsonrpc: '2.0', method, params }, 5000).catch(() => {})
  }

  stop(): void {
    this.sessionId = null
  }
}

function transportFor(name: string, cfg: McpServerConfig): McpTransport {
  const kind = cfg.transport ?? (cfg.url ? 'http' : 'stdio')
  return kind === 'stdio' ? new StdioTransport(name, cfg) : new HttpTransport(name, cfg)
}

// One MCP server connection — wire-agnostic, delegates framing to a transport.
class McpConnection {
  private transport: McpTransport
  private tools: McpTool[] = []

  constructor(private readonly name: string, private readonly cfg: McpServerConfig) {
    this.transport = transportFor(name, cfg)
  }

  async start(): Promise<McpTool[]> {
    await this.transport.start()
    await this.transport.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'grasp', version: '0.1.0' }
    }, INIT_TIMEOUT_MS)
    this.transport.notify('notifications/initialized', {})
    const res = (await this.transport.request('tools/list', {}, INIT_TIMEOUT_MS)) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: object }>
    }
    const hidden = new Set(this.cfg.disabledTools ?? [])
    this.tools = (res.tools ?? [])
      .filter((t) => !hidden.has(t.name))
      .map((t) => ({
        server: this.name,
        name: `${this.name}__${t.name}`,
        description: t.description?.trim() || `(mcp:${this.name}/${t.name})`,
        input_schema: t.inputSchema ?? { type: 'object', properties: {} }
      }))
    return this.tools
  }

  async callTool(localName: string, args: Record<string, unknown>): Promise<string> {
    const remote = localName.startsWith(this.name + '__') ? localName.slice(this.name.length + 2) : localName
    const res = (await this.transport.request('tools/call', { name: remote, arguments: args }, INIT_TIMEOUT_MS)) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
    return res.isError ? `mcp error (${this.name}/${remote}): ${text || '(no detail)'}` : text
  }

  stop(): void {
    this.transport.stop()
  }
}

// All configured MCP servers for a workspace. Start once, merge `.tools` into the agent's
// tool registry, and route calls by tool name to the owning connection.
export interface McpServerStatus {
  name: string
  ok: boolean
  error?: string
  toolCount: number
  disabled?: boolean
  transport?: 'stdio' | 'http' | 'sse'
}

export class McpRegistry {
  private conns: McpConnection[] = []
  private route = new Map<string, McpConnection>()
  readonly tools: McpTool[] = []
  readonly status: McpServerStatus[] = []

  async start(workspace: string): Promise<{ ok: boolean; errors: string[] }> {
    const cfg = loadMcpConfig(workspace)
    const names = Object.keys(cfg)
    if (names.length === 0) return { ok: true, errors: [] }
    const errors: string[] = []
    for (const name of names) {
      const sc = cfg[name]
      const kind = sc.transport ?? (sc.url ? 'http' : 'stdio')
      if (sc.disabled) {
        this.status.push({ name, ok: false, disabled: true, toolCount: 0, transport: kind })
        continue // configured but intentionally off — visible, not started
      }
      const c = new McpConnection(name, sc)
      try {
        const tools = await c.start()
        this.conns.push(c)
        let count = 0
        for (const t of tools) {
          this.tools.push(t)
          this.route.set(t.name, c)
          count++
        }
        this.status.push({ name, ok: true, toolCount: count, transport: kind })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`${name}: ${msg}`)
        this.status.push({ name, ok: false, error: msg, toolCount: 0, transport: kind })
      }
    }
    return { ok: errors.length === 0, errors }
  }

  owns(toolName: string): boolean {
    return this.route.has(toolName)
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const c = this.route.get(toolName)
    if (!c) return `unknown mcp tool: ${toolName}`
    try {
      return await c.callTool(toolName, args)
    } catch (e) {
      return `mcp tool error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  stop(): void {
    for (const c of this.conns) c.stop()
    this.conns = []
    this.route.clear()
    ;(this.tools as McpTool[]).length = 0
    ;(this.status as McpServerStatus[]).length = 0
  }
}
