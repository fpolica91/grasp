// Repo Codemap — an AI-generated STRUCTURAL map of the codebase (symbols + roles +
// dependencies + entry points), persisted to <ws>/.grasp/codemap.md. The structural
// cousin of the Wiki (which is prose). Agent-generated via one-shot — no LSP needed.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { oneShot } from './oneshot'
import type { RepoWiki } from '../shared/types' // {ok, markdown?, generatedAt?, error?} — same shape

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache', '.worktrees', '.corpus', '.grasp', '.idea'])
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.cs', '.php', '.swift', '.kt', '.c', '.cpp', '.h', '.m', '.lua'])
const MAX_FILES = 14
const MAX_CHARS = 700

// Sample up to MAX_FILES source files (shallow walk) so the model can list REAL symbols.
function gatherSource(workspace: string): string {
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || files.length >= MAX_FILES) return
    let entries: string[]
    try { entries = readdirSync(dir).filter((e) => !SKIP.has(e)).sort() } catch { return }
    for (const e of entries) {
      if (files.length >= MAX_FILES) break
      const p = join(dir, e)
      let isDir: boolean
      try { isDir = statSync(p).isDirectory() } catch { continue }
      if (isDir) { walk(p, depth + 1); continue }
      if (SRC_EXT.has(extname(e))) {
        try {
          const body = readFileSync(p, 'utf-8').replace(/\s+\n/g, '\n').slice(0, MAX_CHARS)
          files.push(`### ${relative(workspace, p)}\n\`\`\`${extname(e).slice(1)}\n${body}\n\`\`\``)
        } catch { /* unreadable — skip */ }
      }
    }
  }
  walk(workspace, 0)
  return files.join('\n\n')
}

const SYSTEM =
  'You produce a precise, ACCURATE code-structure map (a "codemap") of a repository, for onboarding and as agent context. ' +
  'Use ONLY the provided source files. For each significant file, list its key SYMBOLS (exported functions, classes, types, constants) with a one-line role each, then note its main dependencies/imports. ' +
  'Group by directory (one ## section per directory). Format each symbol as a bullet: `- name(args?) — one-line role`. ' +
  'If a file was not provided, do NOT invent its symbols — omit it. ' +
  'End with a "## Entry points" section naming the main runtime entry file(s) and how the app starts. ' +
  'Markdown only, no preamble.'

export function readCodemap(workspace: string): RepoWiki {
  const p = join(workspace, '.grasp', 'codemap.md')
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

export async function generateCodemap(workspace: string, backend: string, model?: string): Promise<RepoWiki> {
  if (!workspace || !existsSync(workspace)) return { ok: false, error: 'no workspace' }
  const ctx = gatherSource(workspace)
  if (!ctx.trim()) return { ok: false, error: 'no source files found to map' }
  const res = await oneShot({ backend, model, system: SYSTEM, user: ctx, maxTokens: 2048 })
  if (!res.ok || !res.text) return { ok: false, error: res.error ?? 'codemap generation failed' }
  try {
    const dir = join(workspace, '.grasp')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'codemap.md'), res.text, 'utf-8')
  } catch (e) {
    return { ok: false, error: `generated but not saved: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, markdown: res.text, generatedAt: Date.now() }
}
