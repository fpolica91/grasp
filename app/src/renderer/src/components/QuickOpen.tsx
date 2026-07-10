// Quick open (mod+P) — a fuzzy file finder over the workspace tree, working in both
// personas. Subsequence match with boundary/streak bonuses; Enter or click opens the
// file through the open-source bridge.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TreeNode } from '../../../shared/types'

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) flatten(n.children ?? [], out)
    else out.push(n.path)
  }
  return out
}

// -1 = no match; higher is better. Boundary hits (start, after / . _ -) and streaks
// score up; long paths score gently down so shallow files win ties.
function score(q: string, path: string): number {
  const lp = path.toLowerCase()
  let qi = 0
  let s = 0
  let streak = 0
  for (let i = 0; i < lp.length && qi < q.length; i++) {
    if (lp[i] === q[qi]) {
      qi++
      streak++
      s += 2 + streak + (i === 0 || '/._-'.includes(lp[i - 1]) ? 6 : 0)
    } else streak = 0
  }
  if (qi < q.length) return -1
  return s - path.length * 0.05
}

export function QuickOpen({ workspace, onPick, onClose }: {
  workspace: string
  onPick: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [files, setFiles] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.grasp.listTree(workspace).then((t) => setFiles(flatten(t)))
    inputRef.current?.focus()
  }, [workspace])

  const matches = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return files.slice(0, 40)
    return files
      .map((p) => [score(query, p), p] as const)
      .filter(([s]) => s >= 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 40)
      .map(([, p]) => p)
  }, [q, files])
  useEffect(() => setSel(0), [q])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter' && matches[sel]) { e.preventDefault(); onPick(matches[sel]) }
  }

  const base = (p: string): string => p.split('/').pop() ?? p
  const dir = (p: string): string => p.split('/').slice(0, -1).join('/')

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-[600px] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[14px] text-foreground outline-none placeholder:text-foreground-subtlest"
          placeholder="Go to file…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {matches.map((p, i) => (
            <button
              key={p}
              className={`flex w-full items-baseline gap-2 px-4 py-1.5 text-left transition-colors ${i === sel ? 'bg-selected' : 'hover:bg-surface-hover'}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => onPick(p)}
            >
              <span className="shrink-0 text-[13px] font-medium text-foreground">{base(p)}</span>
              <span className="truncate font-mono text-[11px] text-foreground-subtlest">{dir(p)}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-foreground-subtlest">
              {files.length === 0 ? 'reading the workspace tree…' : 'no files match'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
