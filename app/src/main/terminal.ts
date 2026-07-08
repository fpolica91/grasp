// The integrated terminal — a real pty in the workspace. You run tests, servers, and
// `claude` here and read the output without leaving grasp. node-pty streams bytes both
// ways over IPC; the renderer draws them with xterm.
// @lydell/node-pty ships types that don't resolve through its package "exports",
// so we type the slice we use locally.
// @ts-expect-error - see above
import * as pty from '@lydell/node-pty'
import type { WebContents } from 'electron'
import { remoteStatus } from './remote'

interface IPtyProc {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
}

interface Term {
  proc: IPtyProc
  sender: WebContents
}
const terms = new Map<string, Term>()

const shell = (): string => process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')

export function createTerminal(sender: WebContents, id: string, cwd: string, cols: number, rows: number): void {
  killTerminal(id) // replace any stale terminal with this id
  // Remote SSH session active → the terminal IS a remote shell (cd'd into the workspace).
  const st = remoteStatus()
  let file: string
  let args: string[]
  let localCwd: string
  if (st.active && st.user && st.host) {
    file = 'ssh'
    // Land a login shell in the remote workspace dir. -tt forces a pty.
    const target = `${st.user}@${st.host}`
    const dir = cwd || st.cwd || ''
    args = dir ? ['-tt', target, `cd ${JSON.stringify(dir)} 2>/dev/null; exec $SHELL -l`] : ['-tt', target]
    localCwd = process.cwd()
  } else {
    file = shell()
    args = []
    localCwd = cwd || process.env.GRASP_WORKSPACE || process.cwd()
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: localCwd,
    env: { ...process.env, TERM: 'xterm-256color', GIT_PAGER: 'cat', PAGER: 'cat' }
  }) as IPtyProc
  terms.set(id, { proc, sender })
  proc.onData((data) => {
    if (!sender.isDestroyed()) sender.send('terminal:data', { id, data })
  })
  proc.onExit(({ exitCode }) => {
    if (!sender.isDestroyed()) sender.send('terminal:exit', { id, exitCode })
    terms.delete(id)
  })
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.proc.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  try {
    terms.get(id)?.proc.resize(Math.max(1, cols), Math.max(1, rows))
  } catch {
    /* resize can race a just-exited pty; ignore */
  }
}

export function killTerminal(id: string): void {
  const t = terms.get(id)
  if (t) {
    try {
      t.proc.kill()
    } catch {
      /* already gone */
    }
    terms.delete(id)
  }
}
