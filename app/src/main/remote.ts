// Remote workspace — a persistent SSH session (ssh2) that the whole workspace routes
// through when active, so the agent RUNS ON THE REMOTE (like VS Code Remote-SSH): file
// reads/writes/edits, the shell, the file tree, and the terminal all execute over this
// one connection. grasp stores no secrets beyond the session; key/password is used
// in-memory only.
//
// Security: StrictHostKeyChecking parity is NOT available via ssh2 (no host verifier
// wired here), so we connect with whatever ssh2 accepts. For hostile networks prefer
// key auth and a known host. The system-ssh remote_bash tool (ssh.ts) still enforces
// StrictHostKeyChecking for ad-hoc use.
import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// ssh2's SFTPWrapper is callback-typed in @types/ssh2 but the runtime supports promise
// calls. This is the promise view we use.
interface SftpP {
  readdir(path: string): Promise<Array<{ filename: string; longname: string }>>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string | Buffer): Promise<void>
  end(): void
}

export interface RemoteOptions {
  host: string
  port?: number
  user?: string
  keyPath?: string      // path to a private key (~ expanded)
  password?: string     // optional; mutually exclusive with key
  passphrase?: string
}

export interface RemoteStatus {
  active: boolean
  host?: string
  user?: string
  cwd?: string // remote working dir (home) — the "workspace" when remote
  platform?: string
}

let client: Client | null = null
let sftp: SftpP | null = null
let info: { host: string; user?: string; cwd: string; platform?: string } | null = null

const expand = (p: string): string => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p)

export function remoteStatus(): RemoteStatus {
  if (!client || !info) return { active: false }
  return { active: true, host: info.host, user: info.user, cwd: info.cwd, platform: info.platform }
}

export function remoteDisconnect(): void {
  try { sftp?.end() } catch { /* ignore */ }
  try { client?.end() } catch { /* ignore */ }
  client = null
  sftp = null
  info = null
}

function buildConfig(o: RemoteOptions): ConnectConfig {
  const cfg: ConnectConfig = {
    host: o.host,
    port: o.port ?? 22,
    username: o.user || '',
    readyTimeout: 20_000,
    keepaliveInterval: 15_000
  }
  if (o.password) cfg.password = o.password
  if (o.keyPath) {
    try { cfg.privateKey = readFileSync(expand(o.keyPath)) } catch { /* missing key -> let connect fail */ }
    if (o.passphrase) cfg.passphrase = o.passphrase
  }
  return cfg
}

export function remoteConnect(o: RemoteOptions): Promise<{ ok: boolean; error?: string; cwd?: string; platform?: string }> {
  return new Promise((resolve) => {
    if (!o.host || !o.user) return resolve({ ok: false, error: 'host and user are required' })
    if (!o.keyPath && !o.password) return resolve({ ok: false, error: 'provide a private key or a password' })
    remoteDisconnect()
    const c = new Client()
    const settle = (r: { ok: boolean; error?: string; cwd?: string; platform?: string }): void => {
      if (!r.ok) { try { c.end() } catch { /* ignore */ } }
      resolve(r)
    }
    c.on('ready', () => {
      c.sftp((err, s) => {
        if (err) return settle({ ok: false, error: `sftp failed: ${err.message}` })
        sftp = s as unknown as SftpP
        c.exec('pwd; uname -s', (e, stream) => {
          if (e) return settle({ ok: false, error: `exec failed: ${e.message}` })
          let out = ''
          stream.on('data', (d: Buffer) => { out += d.toString() })
          stream.stderr.on('data', () => { /* ignore */ })
          stream.on('close', () => {
            const [pwdLine, platLine] = out.split('\n')
            const cwd = (pwdLine || '').trim() || `/home/${o.user}`
            const platform = (platLine || '').trim().toLowerCase()
            client = c
            info = { host: o.host, user: o.user, cwd, platform }
            settle({ ok: true, cwd, platform })
          })
        })
      })
    })
    c.on('error', (e) => settle({ ok: false, error: e.message }))
    try {
      c.connect(buildConfig(o))
    } catch (e) {
      settle({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

export interface RemoteExecResult { ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }
const OUT_CAP = 200_000
const cap = (s: string): string => (s.length > OUT_CAP ? s.slice(-OUT_CAP) : s)

export function remoteExec(command: string, cwd?: string, timeoutMs = 60_000): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    if (!client || !info) return resolve({ ok: false, stdout: '', stderr: 'no remote connection', code: null, error: 'no remote connection' })
    const dir = cwd || info.cwd
    const full = `mkdir -p ${JSON.stringify(dir)} && cd ${JSON.stringify(dir)} && ${command}`
    client.exec(full, (err, stream) => {
      if (err) return resolve({ ok: false, stdout: '', stderr: err.message, code: null, error: err.message })
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => { stdout = cap(stdout + d.toString()) })
      stream.stderr.on('data', (d: Buffer) => { stderr = cap(stderr + d.toString()) })
      const timer = setTimeout(() => { try { stream.signal('KILL') } catch { /* ignore */ } }, timeoutMs)
      stream.on('close', (code: number) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, stdout, stderr, code })
      })
    })
  })
}

// ── SFTP file ops (the remote equivalents of fs) ──────────────────────────────
export interface RemoteNode { name: string; path: string; dir: boolean; children?: RemoteNode[] }

export async function remoteListDir(path: string): Promise<RemoteNode[]> {
  if (!sftp) throw new Error('no remote connection')
  const list = await sftp.readdir(path)
  return list
    .map((e) => ({ name: e.filename, path: `${path.replace(/\/$/, '')}/${e.filename}`, dir: e.longname?.[0] === 'd' }))
    .filter((n) => !n.name.startsWith('.'))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

export async function remoteReadFile(path: string): Promise<string> {
  if (!sftp) throw new Error('no remote connection')
  return (await sftp.readFile(path)).toString('utf8')
}

export async function remoteWriteFile(path: string, content: string): Promise<void> {
  if (!sftp) throw new Error('no remote connection')
  await sftp.writeFile(path, content)
}
