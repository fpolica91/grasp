// OS-level sandbox for the agent's shell tool — macOS seatbelt (sandbox-exec).
// Confines WRITES to the workspace + temp (reads/process/network allowed by default,
// so commands still run), with an optional network kill. Fail-closed: if a sandbox is
// requested but unavailable, the caller refuses to run rather than execute unsandboxed.
//
// Enable via env: GRASP_SANDBOX=1 ; GRASP_SANDBOX_NETWORK=off cuts network entirely.
// (Domain-level allow/deny filtering is deferred — that needs a loopback proxy.)
import { writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let _hasExec: boolean | null = null
export function sandboxAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  if (_hasExec === null) _hasExec = existsSync('/usr/bin/sandbox-exec')
  return _hasExec
}
export function sandboxEnabled(): boolean {
  const v = process.env.GRASP_SANDBOX
  return v === '1' || v === 'true'
}
export function sandboxNetwork(): 'on' | 'off' {
  return process.env.GRASP_SANDBOX_NETWORK === 'off' ? 'off' : 'on'
}

/** A seatbelt profile: deny all writes, re-allow only workspace + temp; optional network off. */
export function buildProfile(workspace: string, network: 'on' | 'off' = 'on'): string {
  const q = (p: string): string => (p || '').replace(/"/g, '\\"')
  const lines = [
    '(version 1)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${q(workspace)}"))`,
    `(allow file-write* (subpath "${q(process.env.TMPDIR ?? '/tmp')}"))`,
    `(allow file-write* (subpath "/private/tmp"))`,
    `(allow file-write* (subpath "/tmp"))`
  ]
  if (network === 'off') lines.push('(deny network*)')
  return lines.join('\n')
}

let _n = 0
/** Write the profile to a unique temp file; returns its path. Caller must delete it. */
export function writeProfile(workspace: string, network: 'on' | 'off'): string {
  const p = join(tmpdir(), `grasp-sb-${process.pid}-${_n++}.sb`)
  writeFileSync(p, buildProfile(workspace, network))
  return p
}
