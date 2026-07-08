// The workspace file service for the editor pane — list the tree, read/write files,
// and produce a text diff (git HEAD vs working tree). Everything is confined to the
// workspace; paths that escape it are refused.
//
// REMOTE-AWARE: when a remote SSH session is active (remoteStatus().active), every op
// routes over SFTP/exec on the remote machine — so the editor shows REMOTE files and
// edits land on the remote (VS Code Remote-SSH style). Otherwise local fs.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { remoteStatus, remoteListDir, remoteReadFile, remoteWriteFile, remoteExec } from './remote'

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

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const joinRemote = (workspace: string, rel: string): string =>
  (`${workspace.replace(/\/$/, '')}/${(rel || '').replace(/^\/+/, '')}`).replace(/\/+$/, '') || workspace
const relOf = (workspace: string, abs: string): string =>
  abs.startsWith(workspace) ? abs.slice(workspace.length).replace(/^\/+/, '') : abs

// ── local walk ──────────────────────────────────────────────────────────────
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

// ── remote walk (SFTP) ──────────────────────────────────────────────────────
async function remoteWalk(abs: string, workspace: string, depth: number): Promise<TreeNode[]> {
  if (depth > 6) return []
  let nodes
  try {
    nodes = await remoteListDir(abs)
  } catch {
    return []
  }
  const out: TreeNode[] = []
  for (const n of nodes) {
    if (n.name.startsWith('.git') || SKIP.has(n.name)) continue
    const rel = relOf(workspace, n.path)
    if (n.dir) out.push({ name: n.name, path: rel, dir: true, children: await remoteWalk(n.path, workspace, depth + 1) })
    else out.push({ name: n.name, path: rel, dir: false })
  }
  return out
}

export async function listTree(workspace: string): Promise<TreeNode[]> {
  const st = remoteStatus()
  if (st.active && st.cwd) { const cwd = st.cwd; return remoteWalk(cwd, cwd, 0) }
  const ws = workspace || process.env.GRASP_WORKSPACE || process.cwd()
  return walk(resolve(ws), resolve(ws), 0)
}

export async function readWorkspaceFile(workspace: string, rel: string): Promise<{ ok: boolean; content?: string; error?: string }> {
  const st = remoteStatus()
  if (st.active && st.cwd) { const cwd = st.cwd; 
    try { return { ok: true, content: await remoteReadFile(joinRemote(cwd, rel)) } }
    catch (e) { return { ok: false, error: msg(e) } }
  }
  try {
    const abs = inside(resolve(workspace), rel)
    if (!existsSync(abs) || statSync(abs).isDirectory()) return { ok: false, error: 'not a file' }
    return { ok: true, content: readFileSync(abs, 'utf-8') }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function writeWorkspaceFile(workspace: string, rel: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const st = remoteStatus()
  if (st.active && st.cwd) { const cwd = st.cwd; 
    try { await remoteWriteFile(joinRemote(cwd, rel), content); return { ok: true } }
    catch (e) { return { ok: false, error: msg(e) } }
  }
  try {
    writeFileSync(inside(resolve(workspace), rel), content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

// Text diff = the file at git HEAD (old) vs the current working tree (new). A brand-new
// file has old = '' (no prior version).
export function fileDiff(workspace: string, rel: string): Promise<{ ok: boolean; old: string; new: string; error?: string }> {
  const st = remoteStatus()
  if (st.active && st.cwd) { const cwd = st.cwd; 
    // remote: read current via SFTP, old via `git show HEAD:rel` over ssh
    return (async () => {
      let now = ''
      try { now = await remoteReadFile(joinRemote(cwd, rel)) } catch { /* missing */ }
      const r = await remoteExec(`git show ${JSON.stringify(`HEAD:${rel}`)} 2>/dev/null`, cwd, 15_000)
      return { ok: true, old: r.ok ? r.stdout : '', new: now }
    })()
  }
  return new Promise((res) => {
    const ws = resolve(workspace)
    let now = ''
    try {
      const abs = inside(ws, rel)
      if (existsSync(abs) && !statSync(abs).isDirectory()) now = readFileSync(abs, 'utf-8')
    } catch (e) {
      return res({ ok: false, old: '', new: '', error: msg(e) })
    }
    const cp = spawn('git', ['show', `HEAD:${rel}`], { cwd: ws })
    let old = ''
    cp.stdout.on('data', (d) => (old += d))
    cp.on('error', () => res({ ok: true, old: '', new: now })) // no git -> treat as all-new
    cp.on('close', (code) => res({ ok: true, old: code === 0 ? old : '', new: now }))
  })
}
