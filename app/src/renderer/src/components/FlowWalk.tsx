// The Flow WALK — the same observed trace, read as a numbered narrative instead of a
// tree. Each meaningful frame is an anchor: number chip, function, file:line chip, and
// the REAL source line (read from the workspace, never paraphrased) plus the observed
// values that flowed through it. Clicking an anchor opens the editor at that line and
// starts the tour (gutter badges + inline pill live in Files.tsx). Facts only: labels
// are the code's own names and measured values — no verdicts, no generated prose.
import { useEffect, useMemo, useState } from 'react'
import type { TraceDoc, TraceFrame } from '../../../shared/trace'

export interface WalkAnchor {
  n: number // 1-based anchor number, in observed execution order
  id: string
  fn: string
  file: string
  line: number | null // function definition line (click/gutter target)
  frame: TraceFrame
}

// Derive the walk from a trace: meaningful frames in execution (seq) order.
export function walkAnchorsOf(t: TraceDoc): WalkAnchor[] {
  return [...t.frames]
    .sort((a, b) => a.seq - b.seq)
    .filter((f) => f.meaningful !== false)
    .map((f, i) => ({ n: i + 1, id: f.id, fn: f.fn, file: f.file ?? '', line: f.line ?? null, frame: f })) // normalize: absent line/file must behave as null/empty everywhere downstream
}

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function valueLine(f: TraceFrame): string {
  const args = f.args.map((a) => cap(a.repr, 28)).join(', ')
  const out = f.threw ? `threw ${f.threw.type}` : f.ret ? `→ ${cap(f.ret.repr, 40)}` : '→ ∅'
  return cap(`(${args}) ${out}`, 110)
}

export function FlowWalk({ trace, anchors, currentIx, onSelect, workspace, compact }: {
  trace: TraceDoc
  anchors: WalkAnchor[]
  currentIx: number | null
  onSelect: (ix: number) => void
  workspace: string
  compact?: boolean // rail mode: tighter, no per-row placeholders, basename header
}): React.JSX.Element {
  // Real source excerpts: read each referenced file once; a missing line is shown as
  // unavailable, never invented.
  const files = useMemo(() => [...new Set(anchors.map((a) => a.file).filter(Boolean))], [anchors])
  const [lines, setLines] = useState<Record<string, string[] | null>>({})
  useEffect(() => {
    let dead = false
    for (const f of files) {
      if (f in lines) continue
      void window.grasp.readFile(workspace, f).then((r) => {
        if (!dead) setLines((m) => ({ ...m, [f]: r.ok && typeof r.content === 'string' ? r.content.split('\n') : null }))
      })
    }
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, workspace])

  const excerpt = (a: WalkAnchor): string | null => {
    if (!a.line) return null
    const src = lines[a.file]
    if (!src) return null
    const ln = src[a.line - 1]
    return ln === undefined ? null : cap(ln.trim(), 96)
  }

  const plumbing = trace.frames.length - anchors.length
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* header — the observed facts of this run */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate font-mono text-[0.8125rem] font-semibold text-foreground" title={trace.entry}>
            {(() => {
              if (!compact) return trace.entry
              // keep what matters: basename:symbol — the path start is the tooltip's job
              const ci = trace.entry.lastIndexOf(':')
              const path = ci > 0 ? trace.entry.slice(0, ci) : trace.entry
              const sym = ci > 0 ? trace.entry.slice(ci) : ''
              return `${path.split('/').pop()}${sym}`
            })()}
          </span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[0.625rem] ${trace.status === 'threw' ? 'bg-destructive/15 text-destructive' : 'bg-tag text-foreground-subtle'}`}>{trace.status}</span>
        </div>
        <div className="mt-1 font-mono text-[0.6875rem] text-foreground-subtlest">
          {anchors.length} meaningful step{anchors.length === 1 ? '' : 's'}
          {plumbing > 0 && ` · ${plumbing} plumbing collapsed`}
          {typeof trace.durationMs === 'number' && ` · ${trace.durationMs}ms`}
          {trace.how && ` · ${cap(trace.how, 48)}`}
        </div>
      </div>
      {/* the walk — numbered anchors on a rail */}
      <div className={`relative flex-1 ${compact ? 'px-2 py-2' : 'px-4 py-3'}`}>
        <div className={`absolute bottom-3 top-3 w-px bg-border ${compact ? 'left-[19px]' : 'left-[27px]'}`} />
        <div className="flex flex-col gap-1">
          {anchors.map((a, ix) => {
            const ex = excerpt(a)
            const current = ix === currentIx
            return (
              <button
                key={a.id}
                className={`relative rounded-lg border py-1.5 pl-9 pr-3 text-left transition-colors ${current ? 'border-accent-blue/60 bg-selected' : 'border-transparent hover:bg-surface-hover'}`}
                onClick={() => onSelect(ix)}
                title={a.file ? `open ${a.file}${a.line ? `:${a.line}` : ''}` : undefined}
              >
                <span className={`absolute left-1.5 top-2 z-10 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 font-mono text-[0.625rem] font-semibold ${current ? 'bg-accent-blue text-white' : 'bg-tag text-foreground-subtle'}`}>{a.n}</span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate font-mono text-[0.8125rem] font-semibold text-foreground">{a.fn}</span>
                  {a.file && !compact && (
                    <span className="truncate font-mono text-[0.6875rem] text-foreground-subtlest">{a.file}{a.line ? `:${a.line}` : ''}</span>
                  )}
                  {a.frame.durMs > 0 && <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-foreground-subtlest">{a.frame.durMs}ms</span>}
                </span>
                {ex !== null ? (
                  <span className="mt-0.5 block truncate font-mono text-[0.75rem] text-foreground">{ex}</span>
                ) : compact ? null : (
                  <span className="mt-0.5 block font-mono text-[0.6875rem] italic text-foreground-subtlest">source line unavailable</span>
                )}
                <span className={`mt-0.5 block truncate font-mono text-[0.75rem] ${a.frame.threw ? 'text-destructive' : 'text-foreground-subtle'}`}>{valueLine(a.frame)}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
