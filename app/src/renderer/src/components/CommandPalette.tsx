// Command palette (Cmd/Ctrl+K) — fuzzy over commands + sessions. Type to filter, arrows
// to move, Enter to run, Esc to close. Migrated to Tailwind v4 utilities matching ZCode.
import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

// Loose subsequence match (VSCode-ish) with a light score.
function score(q: string, s: string): number {
  if (!q) return 1
  const t = s.toLowerCase()
  let i = 0
  let hits = 0
  for (const c of q.toLowerCase()) {
    const at = t.indexOf(c, i)
    if (at === -1) return 0
    hits += at === i ? 2 : 1
    i = at + 1
  }
  return hits
}

export function CommandPalette({ items, onClose }: { items: Command[]; onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const scored = items.map((c) => ({ c, s: score(q, c.label + ' ' + c.group) })).filter((x) => x.s > 0)
    scored.sort((a, b) => b.s - a.s)
    return scored.map((x) => x.c)
  }, [items, q])

  useEffect(() => {
    setSel(0)
  }, [q])
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (c?: Command): void => {
    if (c) {
      onClose()
      c.run()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/80 backdrop-blur-[3px] pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="w-full border-0 border-b border-border bg-transparent px-4 py-3 text-[0.875rem] text-foreground outline-none placeholder:text-foreground-subtlest"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[sel])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
          placeholder="Search commands and sessions…"
          spellCheck={false}
        />
        <div className="max-h-[400px] overflow-y-auto p-1" ref={listRef}>
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[0.8125rem] text-foreground-subtlest">No matches.</div>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              data-selected={i === sel}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[0.8125rem] transition-colors ${
                i === sel ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'
              }`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="shrink-0 text-[0.625rem] font-medium uppercase tracking-wide text-foreground-subtlest">
                {c.group}
              </span>
              <span className="flex-1 truncate font-medium">{c.label}</span>
              {c.hint && (
                <span className="shrink-0 font-mono text-[0.6875rem] text-foreground-subtlest">{c.hint}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
