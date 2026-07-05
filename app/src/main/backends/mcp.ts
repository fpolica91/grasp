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
  command: string
  args?: string[]
  env?: Record<string, string>
}
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

export function loadMcpConfig(workspace: string): McpConfig {
  const merged: McpConfig = {}
  for (const p of [userConfigPath(), projectConfigPath(workspace)]) {
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
    if (!s || typeof s.command !== 'string') delete merged[k]
  }
  return merged
}

// One MCP server connection (stdio JSON-RPC). newline-delimited JSON on stdin/stdout.
class McpConnection {
  private proc: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private tools: McpTool[] = []

  constructor(private readonly name: string, private readonly cfg: McpServerConfig) {}

  async start(): Promise<McpTool[]> {
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.cfg.env }
    })
    this.proc = proc
    proc.stdout?.setEncoding('utf-8')
    proc.stdout?.on('data', (d: string) => this.onData(d))
    proc.on('error', (e) => this.failAll(e.message))
    proc.on('close', () => this.failAll(`mcp server "${this.name}" closed`))

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'grasp', version: '0.1.0' }
    })
    this.notify('notifications/initialized', {})
    const res = (await this.request('tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: object }>
    }
    this.tools = (res.tools ?? []).map((t) => ({
      server: this.name,
      name: `${this.name}__${t.name}`,
      description: t.description?.trim() || `(mcp:${this.name}/${t.name})`,
      input_schema: t.inputSchema ?? { type: 'object', properties: {} }
    }))
    return this.tools
  }

  async callTool(localName: string, args: Record<string, unknown>): Promise<string> {
    const remote = localName.startsWith(this.name + '__') ? localName.slice(this.name.length + 2) : localName
    const res = (await this.request('tools/call', { name: remote, arguments: args })) as {
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
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue /* not JSON — skip */
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message ?? `mcp ${this.name} error`))
        else p.resolve(msg.result)
      }
      // server-initiated notifications/requests (no id) are ignored for now.
    }
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.proc?.stdin) return Promise.reject(new Error(`mcp server "${this.name}" not started`))
    const id = this.nextId++
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp "${this.name}" ${method} timed out`))
      }, INIT_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
        timer
      })
      this.proc!.stdin!.write(msg + '\n')
    })
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  private failAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

// All configured MCP servers for a workspace. Start once, merge `.tools` into the agent's
// tool registry, and route calls by tool name to the owning connection.
export class McpRegistry {
  private conns: McpConnection[] = []
  private route = new Map<string, McpConnection>()
  readonly tools: McpTool[] = []

  async start(workspace: string): Promise<{ ok: boolean; errors: string[] }> {
    const cfg = loadMcpConfig(workspace)
    const names = Object.keys(cfg)
    if (names.length === 0) return { ok: true, errors: [] }
    const errors: string[] = []
    for (const name of names) {
      const c = new McpConnection(name, cfg[name])
      try {
        const tools = await c.start()
        this.conns.push(c)
        for (const t of tools) {
          this.tools.push(t)
          this.route.set(t.name, c)
        }
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
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
  }
}
