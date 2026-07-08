// The workspace file service for the editor pane — list the tree, read/write files,
// and produce a text diff (git HEAD vs working tree). Everything is confined to the
// workspace; paths that escape it are refused.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

const SKIP = new Set(['.git', 'node_modules', '.venv', 'dist', 'out', '.worktrees', '__pycache__', '.corpus'])

export interface TreeNode {
  name: string
  path: string // relative to the workspace
  dir: boolean
  children?: TreeNode[]
}

function inside(workspace: string, rel: string): string {
  const abs = resolve(workspace, rel || '.')
  if (!abs.startsWith(resolve(workspace))) throw new Error('path escapes the workspace')
  return abs
}

function walk(abs: string, workspace: string, depth: number): TreeNode[] {
  if (depth > 8) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => !e.name.startsWith('.git') && !SKIP.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => {
      const childAbs = join(abs, e.name)
      const rel = relative(workspace, childAbs)
      return e.isDirectory()
        ? { name: e.name, path: rel, dir: true, children: walk(childAbs, workspace, depth + 1) }
        : { name: e.name, path: rel, dir: false }
    })
}

export function listTree(workspace: string): TreeNode[] {
  const ws = workspace || process.env.GRASP_WORKSPACE || process.cwd()
  return walk(resolve(ws), resolve(ws), 0)
}

export function readWorkspaceFile(workspace: string, rel: string): { ok: boolean; content?: string; error?: string } {
  try {
    const abs = inside(resolve(workspace), rel)
    if (!existsSync(abs) || statSync(abs).isDirectory()) return { ok: false, error: 'not a file' }
    return { ok: true, content: readFileSync(abs, 'utf-8') }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function writeWorkspaceFile(workspace: string, rel: string, content: string): { ok: boolean; error?: string } {
  try {
    writeFileSync(inside(resolve(workspace), rel), content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Text diff = the file at git HEAD (old) vs the current working tree (new). A brand-new
// file has old = '' (it "no longer runs" has no prior version).
export function fileDiff(workspace: string, rel: string): Promise<{ ok: boolean; old: string; new: string; error?: string }> {
  return new Promise((res) => {
    const ws = resolve(workspace)
    let now = ''
    try {
      const abs = inside(ws, rel)
      if (existsSync(abs) && !statSync(abs).isDirectory()) now = readFileSync(abs, 'utf-8')
    } catch (e) {
      return res({ ok: false, old: '', new: '', error: e instanceof Error ? e.message : String(e) })
    }
    const cp = spawn('git', ['show', `HEAD:${rel}`], { cwd: ws })
    let old = ''
    cp.stdout.on('data', (d) => (old += d))
    cp.on('error', () => res({ ok: true, old: '', new: now })) // no git -> treat as all-new
    cp.on('close', (code) => res({ ok: true, old: code === 0 ? old : '', new: now }))
  })
}
