// Symbol extraction via per-language regex (no model, no LSP, no AI prose) — real
// declarations parsed from the source. Feeds the editor's Outline panel (fileSymbols).
// The old whole-repo Codemap pane was removed; this survives as its useful core.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import type { CodeSymbol } from '../shared/types'

const MAX_SYMBOLS_PER_FILE = 30

// Per-language regex patterns. Maps ext → [{ kind, regex }]. The regex captures the
// symbol name in group 1. These are real declarations parsed from the source — not AI.
const LANG_PATTERNS: Record<string, { kind: string; re: RegExp }[]> = {
  ts: [
    { kind: 'function', re: /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g },
    { kind: 'class', re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'interface', re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'type', re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<{]/g },
    { kind: 'const', re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/g },
  ],
  py: [
    { kind: 'def', re: /def\s+([A-Za-z_][\w]*)/g },
    { kind: 'class', re: /class\s+([A-Za-z_][\w]*)/g },
  ],
  go: [{ kind: 'func', re: /func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/g }],
  rs: [
    { kind: 'fn', re: /(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/g },
    { kind: 'struct', re: /(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/g },
    { kind: 'enum', re: /(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/g },
    { kind: 'trait', re: /(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/g },
  ],
  java: [
    { kind: 'class', re: /(?:public|private|protected)?\s*(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/g },
    { kind: 'method', re: /(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+([A-Za-z_][\w]*)\s*\(/g },
  ],
  rb: [{ kind: 'def', re: /def\s+([A-Za-z_][\w!?=]*)/g }, { kind: 'class', re: /class\s+([A-Za-z_][\w]*)/g }],
  cs: [{ kind: 'class', re: /(?:public|private|internal)?\s*(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/g }, { kind: 'method', re: /(?:public|private)\s+[\w<>\[\]]+\s+([A-Za-z_][\w]*)\s*\(/g }],
  php: [{ kind: 'function', re: /function\s+([A-Za-z_][\w]*)/g }, { kind: 'class', re: /class\s+([A-Za-z_][\w]*)/g }],
  swift: [{ kind: 'func', re: /(?:public|private|internal)?\s*func\s+([A-Za-z_][\w]*)/g }, { kind: 'struct', re: /struct\s+([A-Za-z_][\w]*)/g }, { kind: 'class', re: /class\s+([A-Za-z_][\w]*)/g }],
  kt: [{ kind: 'fun', re: /fun\s+([A-Za-z_][\w]*)/g }, { kind: 'class', re: /class\s+([A-Za-z_][\w]*)/g }],
  c: [{ kind: 'function', re: /(?:[A-Za-z_][\w]*\s+)+([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/g }, { kind: 'struct', re: /struct\s+([A-Za-z_][\w]*)/g }],
  lua: [{ kind: 'function', re: /function\s+([A-Za-z_][\w.:]*)/g }, { kind: 'local', re: /local\s+function\s+([A-Za-z_][\w]*)/g }],
}

function langKey(ext: string): string | undefined {
  const map: Record<string, string> = { '.ts': 'ts', '.tsx': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.rb': 'rb', '.cs': 'cs', '.php': 'php', '.swift': 'swift', '.kt': 'kt', '.c': 'c', '.cpp': 'c', '.cc': 'c', '.h': 'c', '.hpp': 'c', '.m': 'c', '.lua': 'lua' }
  return map[ext]
}

function extractSymbols(filePath: string, content: string, cap = MAX_SYMBOLS_PER_FILE): CodeSymbol[] {
  const key = langKey(extname(filePath))
  if (!key) return []
  const patterns = LANG_PATTERNS[key]
  if (!patterns) return []
  const symbols: CodeSymbol[] = []
  const seen = new Set<string>()
  for (const { kind, re } of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) && symbols.length < cap) {
      const name = m[1]
      if (!name || name.length < 2 || seen.has(name)) continue
      seen.add(name)
      // compute line number from the match index
      const line = content.slice(0, m.index).split('\n').length
      symbols.push({ name, kind, line })
    }
  }
  return symbols
}

export function fileSymbols(workspace: string, rel: string): { ok: boolean; symbols?: CodeSymbol[]; error?: string } {
  try {
    const ws = resolve(workspace)
    const abs = join(ws, rel)
    if (!abs.startsWith(ws)) return { ok: false, error: 'path escapes the workspace' }
    if (!existsSync(abs)) return { ok: false, error: 'not found' }
    const symbols = extractSymbols(abs, readFileSync(abs, 'utf-8'), 200).sort((a, b) => a.line - b.line)
    return { ok: true, symbols }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
