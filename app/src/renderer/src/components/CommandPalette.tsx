// Command palette (Cmd/Ctrl+K) — fuzzy over commands + sessions. Type to filter, arrows
// to move, Enter to run, Esc to close.
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
    listRef.current?.querySelector('.cmd-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (c?: Command): void => {
    if (c) {
      onClose()
      c.run()
    }
  }

  return (
    <div className="gate-overlay palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
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
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="palette-empty">No matches.</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cmd-item${i === sel ? ' on' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="cmd-group">{c.group}</span>
              <span className="cmd-label">{c.label}</span>
              {c.hint && <span className="cmd-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
