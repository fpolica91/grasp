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
