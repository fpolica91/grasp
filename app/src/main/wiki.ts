// Repo Wiki: an AI-generated single-page repo doc, shown in the right pane. The agent
// (one-shot) reads the file tree + README + manifest and writes a concise wiki to
// <ws>/.grasp/wiki.md; grasp renders it. Regeneration is explicit and cheap.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { oneShot } from './oneshot'
import type { RepoWiki } from '../shared/types'

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache', '.worktrees', '.corpus', '.grasp'])
const MAX_TREE = 70

function tree(workspace: string): string {
  const lines: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || lines.length >= MAX_TREE) return
    let entries: string[]
    try { entries = readdirSync(dir).filter((e) => !SKIP.has(e)).sort() } catch { return }
    for (const e of entries) {
      if (lines.length >= MAX_TREE) { lines.push('…(more)'); return }
      const p = join(dir, e)
      let isDir: boolean
      try { isDir = statSync(p).isDirectory() } catch { continue }
      const rel = relative(workspace, p)
      lines.push(`${isDir ? '📁' : '📄'} ${rel}${isDir ? '/' : ''}`)
      if (isDir && depth < 2) walk(p, depth + 1)
    }
  }
  walk(workspace, 0)
  return lines.join('\n')
}

function readTrim(p: string, max: number): string {
  try { return readFileSync(p, 'utf-8').replace(/\s+\n/g, '\n').slice(0, max) } catch { return '' }
}

/** Gather a compact repo context (README + manifests + shallow tree) for the wiki model. */
function context(workspace: string): string {
  const parts: string[] = []
  const readme = readTrim(join(workspace, 'README.md'), 4000) || readTrim(join(workspace, 'readme.md'), 4000)
  if (readme) parts.push(`# README\n\n${readme}`)
  for (const m of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'setup.py', 'pom.xml']) {
    const t = readTrim(join(workspace, m), 1500)
    if (t) parts.push(`# ${m}\n\n${t}`)
  }
  parts.push(`# File tree (shallow)\n\n${tree(workspace)}`)
  return parts.join('\n\n---\n\n').slice(0, 12000)
}

const SYSTEM =
  'You write a concise, ACCURATE repository wiki in markdown for a developer who is new to the repo. ' +
  'Use ONLY the provided README, manifests, and file tree. Sections: **Overview** (what it is, in 2-3 sentences), ' +
  '**Structure** (the key directories/files and their roles), **Run** (install + how to start, from manifests/scripts), ' +
  '**Test** (how tests run, if known), **Key entrypoints** (the main runtime entry file(s)). ' +
  'If something is not knowable from the provided context, say "not determinable from context" — do NOT invent. ' +
  'Output markdown only, no preamble.'

export function readWiki(workspace: string): RepoWiki {
  const p = join(workspace, '.grasp', 'wiki.md')
  if (!existsSync(p)) return { ok: false, error: 'not generated yet' }
  try {
    const markdown = readFileSync(p, 'utf-8')
    let generatedAt: number | undefined
    try { generatedAt = statSync(p).mtimeMs } catch { /* ignore */ }
    return { ok: true, markdown, generatedAt }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function generateWiki(workspace: string, backend: string, model?: string): Promise<RepoWiki> {
  if (!workspace || !existsSync(workspace)) return { ok: false, error: 'no workspace' }
  const ctx = context(workspace)
  if (!ctx.trim()) return { ok: false, error: 'empty or unreadable workspace' }
  const res = await oneShot({ backend, model, system: SYSTEM, user: ctx, maxTokens: 2048 })
  if (!res.ok || !res.text) return { ok: false, error: res.error ?? 'wiki generation failed' }
  try {
    const dir = join(workspace, '.grasp')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wiki.md'), res.text, 'utf-8')
  } catch (e) {
    return { ok: false, error: `generated but not saved: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, markdown: res.text, generatedAt: Date.now() }
}
