// Git for the Git Graph pane. grasp already shells git for checkpoints; this is the
// read surface (log + branches + ahead/behind) and a small set of safe actions. Never
// forces anything destructive — no reset --hard, no push --force.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GitCommit, GitGraph } from '../shared/types'

const TIMEOUT = 20000

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: TIMEOUT })
  return { code: r.status ?? 1, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() }
}

export function gitGraph(workspace: string, limit = 100): GitGraph {
  if (!workspace || !existsSync(join(workspace, '.git'))) {
    return { ok: false, error: 'not a git repo', branch: '', commits: [], branches: [] }
  }
  const branch = git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD').out || 'HEAD'
  const sep = '␞' // ASCII "record separator" — won't appear in git metadata
  const fmt = `%H${sep}%h${sep}%P${sep}%an${sep}%cr${sep}%s${sep}%d`
  const log = git(workspace, 'log', '-n', String(limit), `--pretty=format:${fmt}`)
  const commits: GitCommit[] = log.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, parents, author, date, subject, refs] = line.split(sep)
      return {
        hash,
        short,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
        refs: (refs ?? '').trim()
      }
    })
  const dirty = git(workspace, 'status', '--porcelain').out.length > 0
  // ahead/behind vs upstream (best-effort — no upstream ⇒ undefined)
  let ahead: number | undefined
  let behind: number | undefined
  const counts = git(workspace, 'rev-list', '--left-right', '--count', '@{u}...HEAD').out.split(/\s+/)
  if (counts.length === 2 && /^\d+$/.test(counts[0]) && /^\d+$/.test(counts[1])) {
    behind = Number(counts[0])
    ahead = Number(counts[1])
  }
  const branches = git(workspace, 'branch', '--format=%(refname:short)')
    .out.split('\n').map((b) => b.trim()).filter(Boolean)
  return { ok: true, branch, commits, branches, dirty, ahead, behind }
}

export function gitAction(
  workspace: string,
  op: 'fetch' | 'pull' | 'push' | 'stageAll' | 'commit' | 'checkout' | 'newBranch' | 'merge' | 'rebase',
  arg?: string
): { ok: boolean; out: string } {
  if (!workspace || !existsSync(join(workspace, '.git'))) return { ok: false, out: 'not a git repo' }
  const run = (...args: string[]): { ok: boolean; out: string } => {
    const r = git(workspace, ...args)
    return { ok: r.code === 0, out: r.out }
  }
  switch (op) {
    case 'fetch': return run('fetch', '--all', '--prune')
    case 'pull': return run('pull', '--ff-only')
    case 'push': return run('push')
    case 'stageAll': return run('add', '-A')
    case 'commit': return run('commit', '-m', String(arg ?? 'update').slice(0, 200))
    case 'checkout': return run('checkout', String(arg))
    case 'newBranch': return run('checkout', '-b', String(arg))
    case 'merge': return run('merge', '--no-edit', String(arg))
    case 'rebase': return run('rebase', String(arg))
    default: return { ok: false, out: `unknown action: ${op}` }
  }
}
