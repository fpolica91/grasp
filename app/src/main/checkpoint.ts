// Turn checkpoints — the fix for A→B diffs. After every agent turn that changed files
// (and before a turn that starts on a dirty tree), grasp commits the workspace, so
// git HEAD is always "the code as of the last accepted state" and the Flow can diff
// old-vs-new on every edit without the human touching git. Also the foundation for
// per-turn Undo. Commits are normal git commits, visibly labeled "grasp:".
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const GIT_ID = ['-c', 'user.name=grasp', '-c', 'user.email=grasp@local']

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf-8', timeout: 15000 })
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

export function checkpointWorkspace(workspace: string, label: string): { committed: boolean } {
  if (!workspace) return { committed: false }
  try {
    // OWNERSHIP LAW: grasp never creates a repo where none exists. A workspace without
    // .git is either a plain project (the human's call to init) or a CONTAINER of repos —
    // and a container owns nothing, checkpoints included. (This guard exists because a
    // checkpoint once git-init'd a container and committed its child repos into it.)
    if (!existsSync(join(workspace, '.git'))) return { committed: false }
    const dirty = git(workspace, 'status', '--porcelain')
    if (dirty.code !== 0 || !dirty.out.trim()) return { committed: false }
    git(workspace, 'add', '-A')
    const msg = `grasp: ${label.replace(/\s+/g, ' ').slice(0, 72)}`
    const c = git(workspace, 'commit', '-q', '-m', msg)
    return { committed: c.code === 0 }
  } catch {
    return { committed: false }
  }
}

// The current baseline commit — "state before this turn" once the pre-turn
// checkpoint has run (committed or already-clean). null outside a git repo.
export function headSha(workspace: string): string | null {
  if (!workspace || !existsSync(join(workspace, '.git'))) return null
  const r = git(workspace, 'rev-parse', 'HEAD')
  return r.code === 0 ? r.out.trim().slice(0, 40) : null
}

// Revert the workspace to a prior baseline. SAFETY: the current state is committed
// first and its sha returned — the revert itself is always recoverable, and the
// chat reports the recovery sha as a fact. Ownership law applies (no .git → refuse).
export function revertToCheckpoint(workspace: string, sha: string): { ok: boolean; safeSha?: string; error?: string } {
  if (!workspace || !existsSync(join(workspace, '.git'))) return { ok: false, error: 'not a git repository' }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { ok: false, error: 'malformed checkpoint sha' }
  if (git(workspace, 'cat-file', '-e', `${sha}^{commit}`).code !== 0) return { ok: false, error: 'unknown checkpoint commit' }
  checkpointWorkspace(workspace, 'state before revert (recovery point)')
  const safeSha = headSha(workspace) ?? undefined
  const r = git(workspace, 'reset', '--hard', sha)
  if (r.code !== 0) return { ok: false, error: r.out.slice(0, 300) }
  return { ok: true, safeSha }
}
