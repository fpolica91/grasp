// SSH remote exec — leans on the SYSTEM ssh binary instead of vendoring ssh2.
// That choice is the security fix: system ssh enforces known_hosts strictly by default
// (StrictHostKeyChecking=yes) and, with BatchMode=yes, REFUSES password prompts — so the
// severe host-key/MITM + password-relay flaw ZCode shipped (ssh2 with no hostVerifier) is
// structurally impossible here. Hosts are the user's own ~/.ssh/config aliases or user@host;
// grasp stores no secrets and adds no keys.
import { spawn, spawnSync } from 'node:child_process'

export interface SshResult {
  ok: boolean
  stdout: string
  stderr: string
  exit: number | null
  error?: string
}

const OUT_CAP = 200_000

// Run `command` on a remote host. key/agent auth only (BatchMode); host key verified against
// ~/.ssh/known_hosts (StrictHostKeyChecking=yes — an unknown/changed host is REFUSED, not
// silently accepted). Aborts cleanly on `signal` (the user's stop button).
export function sshExec(host: string, command: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<SshResult> {
  return new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=yes',
      host,
      command
    ]
    const cp = spawn('ssh', args, { signal })
    let stdout = ''
    let stderr = ''
    const cap = (s: string): string => (s.length > OUT_CAP ? s.slice(-OUT_CAP) : s)
    const timer = setTimeout(() => {
      try {
        cp.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    cp.stdout.on('data', (d) => {
      stdout += d
      stdout = cap(stdout)
    })
    cp.stderr.on('data', (d) => {
      stderr += d
      stderr = cap(stderr)
    })
    cp.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, exit: null, error: `could not run ssh: ${e.message}` })
    })
    cp.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exit: code,
        error: code === 0 ? undefined : `ssh exited ${code}${stderr ? `: ${stderr.split('\n')[0].slice(0, 160)}` : ''}`
      })
    })
  })
}

export function sshAvailable(): boolean {
  try {
    const r = spawnSync('ssh', ['-V'], { timeout: 3000 })
    return r.error === undefined
  } catch {
    return false
  }
}
