// The Flow — grasp's centerpiece. Renders a Trace as a navigable call tree.
// Fully migrated to Tailwind v4 with @theme tokens.
import { useState } from 'react'
import type { TraceDoc, TraceFrame, TraceValue, TraceDiff, FrameDelta, FuzzDiff } from '../../../shared/trace'

function Val({ v }: { v: TraceValue }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-[12px] text-foreground-subtlest">{v.name}</span>
      <span className="font-mono text-[12px] text-foreground">{v.repr}</span>
    </span>
  )
}

function Frame({ frame, children, byParent, onOpenSource }: {
  frame: TraceFrame; children: TraceFrame[]
  byParent: Map<string | null, TraceFrame[]>
  onOpenSource?: (file: string, line: number | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(frame.depth < 1)
  const threw = frame.threw
  return (
    <div className={threw ? 'border-l-2 border-destructive/40' : ''}>
      <div className="flex items-start gap-2 py-1">
        <button className="mt-0.5 border-0 bg-transparent p-0" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={`inline-block text-[9px] text-foreground-subtlest transition-transform ${open ? 'rotate-90' : ''} ${children.length ? '' : 'invisible'}`}>▸</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-foreground">{frame.fn}</span>
            {frame.file && (
              <button className="font-mono text-[11px] text-foreground-subtlest underline underline-offset-2 transition-colors hover:text-foreground" onClick={() => onOpenSource?.(frame.file, frame.line)} title="open source">
                {frame.file}{frame.line ? `:${frame.line}` : ''}
              </button>
            )}
            {frame.durMs > 0 && <span className="text-[11px] text-foreground-subtlest">{frame.durMs.toFixed(1)}ms</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 py-0.5 font-mono text-[12px]">
            <span className="flex flex-wrap items-center gap-1">
              {frame.args.length === 0 ? <span className="italic text-foreground-subtlest">no args</span> : frame.args.map((a, i) => <Val key={i} v={a} />)}
            </span>
            <span className="text-foreground-subtlest">→</span>
            {threw ? (
              <span className="text-destructive">{threw.type}: {threw.message}</span>
            ) : frame.ret ? (
              <span className="text-foreground-subtle">{frame.ret.repr}</span>
            ) : (
              <span className="italic text-foreground-subtlest">no return</span>
            )}
          </div>
          {open && threw && <div className="mt-1 text-[13px] text-foreground-subtle">? {frame.fn} threw {threw.type}: {threw.message} — intended?</div>}
        </div>
      </div>
      {open && children.length > 0 && (
        <div className="ml-4 border-l border-border pl-3">
          {children.map((k) => (<Frame key={k.id} frame={k} children={byParent.get(k.id) ?? []} byParent={byParent} onOpenSource={onOpenSource} />))}
        </div>
      )}
    </div>
  )
}

const shellCls = 'flex h-full flex-col gap-2 overflow-y-auto p-4'
const headEntry = 'font-mono text-[14px] font-semibold text-foreground'
const headLang = 'rounded-full border border-border px-2 text-[10px] uppercase text-foreground-subtlest'
const headMeta = 'text-[11px] text-foreground-subtlest'
const footCls = 'mt-auto pt-3 text-[12px] leading-relaxed text-foreground-subtlest'
const qCls = 'mt-1 text-[13px] text-foreground-subtle'
const unobsBox = 'rounded-xl border border-dashed border-border bg-surface p-4'

export function FlowView({ trace, onOpenSource }: { trace: TraceDoc; onOpenSource?: (file: string, line: number | null) => void }): React.JSX.Element {
  const [showPlumbing, setShowPlumbing] = useState(false)
  if (trace.status === 'unobservable') {
    return (
      <div className={shellCls}>
        <div className="flex items-center gap-2">
          <span className={headEntry}>{trace.entry}</span>
          <span className={headLang}>{trace.language}</span>
        </div>
        <div className={unobsBox}>
          <div className="text-[14px] font-medium text-foreground">grasp couldn&rsquo;t observe this run</div>
          <div className="mt-1 text-[13px] text-foreground-subtle">{trace.unobservable?.reason}</div>
          {trace.unobservable?.hint && <div className="mt-0.5 text-[12px] text-foreground-subtlest">{trace.unobservable.hint}</div>}
          <div className="mt-3 text-[12px] leading-relaxed text-foreground-subtlest">This is a tooling gap, not the code&rsquo;s behavior — grasp will not invent a flow it didn&rsquo;t measure.</div>
        </div>
      </div>
    )
  }
  const plumbingCount = trace.frames.filter((f) => f.meaningful === false).length
  const visible = showPlumbing ? trace.frames : trace.frames.filter((f) => f.meaningful !== false)
  const byParent = new Map<string | null, TraceFrame[]>()
  for (const f of visible) {
    let p = f.parent
    if (!showPlumbing) {
      const byId = new Map(trace.frames.map((x) => [x.id, x]))
      while (p) { const pf = byId.get(p); if (!pf || pf.meaningful !== false) break; p = pf.parent }
    }
    const arr = byParent.get(p) ?? []; arr.push(f); byParent.set(p, arr)
  }
  const roots = byParent.get(null) ?? []
  return (
    <div className={shellCls}>
      <div className="flex items-center gap-2">
        <span className={headEntry}>{trace.entry}</span>
        <span className={headLang}>{trace.language}</span>
        <span className={headMeta}>{trace.frames.length} frame{trace.frames.length === 1 ? '' : 's'}{trace.durationMs != null && ` · ${trace.durationMs.toFixed(1)}ms`}</span>
      </div>
      <div className="text-[12px] text-foreground-subtlest">ran: {trace.how}</div>
      <div className="flex flex-col">
        {roots.map((r) => (<Frame key={r.id} frame={r} children={byParent.get(r.id) ?? []} byParent={byParent} onOpenSource={onOpenSource} />))}
      </div>
      {plumbingCount > 0 && (
        <button className="self-start rounded-md border border-border bg-transparent px-2.5 py-1 text-[12px] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground" onClick={() => setShowPlumbing((v) => !v)}>
          {showPlumbing ? 'hide plumbing' : `show ${plumbingCount} plumbing frame${plumbingCount === 1 ? '' : 's'}`}
        </button>
      )}
      {(trace.stdout || trace.stderr) && (
        <details className="mt-2 rounded-lg border border-border bg-panel p-3">
          <summary className="cursor-pointer text-[12px] text-foreground-subtle">observed output</summary>
          {trace.stdout && <pre className="mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[12px] text-foreground-subtle">{trace.stdout}</pre>}
          {trace.stderr && <pre className="mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[12px] text-destructive">{trace.stderr}</pre>}
        </details>
      )}
      <div className={footCls}>Every value above is measured from one real execution — nothing inferred. grasp surfaces what the code did; whether it is intended is yours to say.</div>
    </div>
  )
}

function DeltaRow({ d, onOpenSource }: { d: FrameDelta; onOpenSource?: (file: string, line: number | null) => void }): React.JSX.Element {
  const f = d.frame
  const statusColor = d.status === 'changed' ? 'text-foreground' : d.status === 'added' ? 'text-foreground-subtle' : d.status === 'removed' ? 'text-destructive' : 'text-foreground-subtlest'
  return (
    <div style={{ marginLeft: `${f.depth * 16}px` }}>
      <div className="flex items-start gap-2 py-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 text-[10px] uppercase ${statusColor} ${d.status === 'changed' ? 'bg-tag' : d.status === 'added' ? 'bg-tag' : d.status === 'removed' ? 'bg-destructive/10' : 'bg-surface'}`}>{d.status}</span>
            <span className="font-mono text-[13px] font-medium text-foreground">{f.fn}</span>
            {f.file && <button className="font-mono text-[11px] text-foreground-subtlest underline underline-offset-2 hover:text-foreground" onClick={() => onOpenSource?.(f.file, f.line)}>{f.file}{f.line ? `:${f.line}` : ''}</button>}
          </div>
          {d.status === 'changed' ? (
            <div className="flex flex-col gap-0.5 py-0.5">
              {d.changes.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5 font-mono text-[12px]">
                  <span className="text-foreground-subtlest">{c.name === '→return' ? 'return' : c.name}</span>
                  <span className="text-destructive line-through opacity-70">{c.old}</span>
                  <span className="text-foreground-subtlest">→</span>
                  <span className="text-foreground">{c.new}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 py-0.5 font-mono text-[12px]">
              <span className="flex flex-wrap gap-1">{f.args.length === 0 ? <span className="italic text-foreground-subtlest">no args</span> : f.args.map((a, i) => <Val key={i} v={a} />)}</span>
              <span className="text-foreground-subtlest">→</span>
              {f.threw ? <span className="text-destructive">{f.threw.type}</span> : f.ret ? <span className="text-foreground-subtle">{f.ret.repr}</span> : <span className="italic text-foreground-subtlest">void</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function FlowDiffView({ diff, onOpenSource }: { diff: TraceDiff; onOpenSource?: (file: string, line: number | null) => void }): React.JSX.Element {
  const [showUnchanged, setShowUnchanged] = useState(false)
  const rows = showUnchanged ? diff.frames : diff.frames.filter((f) => f.status !== 'unchanged')
  return (
    <div className={shellCls}>
      <div className="flex items-center gap-2">
        <span className={headEntry}>{diff.entry}</span>
        <span className={headLang}>A→B</span>
        <span className={headMeta}>{diff.oldRef ?? 'old'} → {diff.newRef ?? 'new'} · {diff.changedCount} change{diff.changedCount === 1 ? '' : 's'}</span>
      </div>
      {diff.empty ? (
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="text-[14px] font-medium text-foreground">Same flow for this input.</div>
          <div className="mt-1 text-[12px] leading-relaxed text-foreground-subtlest">Both versions ran the same call tree with the same values. That is not a pass — it is one observed path.</div>
        </div>
      ) : (
        <>
          <div className="flex flex-col">{rows.map((d, i) => <DeltaRow key={i} d={d} onOpenSource={onOpenSource} />)}</div>
          <button className="self-start rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground-subtlest transition-colors hover:bg-surface-hover" onClick={() => setShowUnchanged((v) => !v)}>
            {showUnchanged ? 'hide unchanged' : `show ${diff.frames.filter((f) => f.status === 'unchanged').length} unchanged`}
          </button>
          {diff.questions.length > 0 && (
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">You adjudicate</div>
              {diff.questions.map((q, i) => <div key={i} className={qCls}>? {q}</div>)}
            </div>
          )}
        </>
      )}
      <div className={footCls}>Old and new were each run for real under the same input; the deltas are measured, not inferred.</div>
    </div>
  )
}

export function FuzzDiffView({ fuzz, onOpenSource }: { fuzz: FuzzDiff; onOpenSource?: (file: string, line: number | null) => void }): React.JSX.Element {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className={shellCls}>
      <div className="flex items-center gap-2">
        <span className={headEntry}>{fuzz.entry}</span>
        <span className={headLang}>fuzz A→B</span>
        <span className={headMeta}>{fuzz.oldRef ?? 'old'} → {fuzz.newRef ?? 'new'} · {fuzz.tried} tried · {fuzz.diverged} diverged</span>
      </div>
      <div className={`rounded-lg px-3 py-1.5 text-[13px] ${fuzz.diverged ? 'bg-destructive/10 text-foreground' : 'bg-surface text-foreground-subtle'}`}>{fuzz.scope}</div>
      {fuzz.diverged > 0 && (
        <div className="flex flex-col gap-1">
          {fuzz.cases.map((c, i) => {
            const changed = c.diff.frames.filter((f) => f.status !== 'unchanged')
            const root = changed.find((f) => f.frame.depth === 0) ?? changed[0]
            const ret = root?.changes.find((ch) => ch.name === '→return' || ch.name === 'return')
            const isOpen = open === i; const canExpand = changed.length > 1
            return (
              <div key={i} className="rounded-lg border border-border bg-surface">
                <div className={`flex items-center gap-2 p-2.5 ${canExpand ? 'cursor-pointer' : ''}`} onClick={canExpand ? () => setOpen(isOpen ? null : i) : undefined}>
                  <div className="flex items-center gap-1.5">
                    {canExpand && <span className={`text-[9px] text-foreground-subtlest transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>}
                    <span className="rounded-full border border-border px-1.5 text-[10px] uppercase text-foreground-subtlest">input</span>
                    <span className="font-mono text-[12px] text-foreground">{JSON.stringify(c.input)}</span>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5 font-mono text-[12px]">
                    {ret ? (<><span className="text-destructive line-through opacity-70">{ret.old}</span><span className="text-foreground-subtlest">→</span><span className="text-foreground">{ret.new}</span></>) : <span className="italic text-foreground-subtlest">{changed.length} frame(s) changed</span>}
                  </div>
                </div>
                {isOpen && <div className="border-t border-border p-2">{changed.map((d, j) => <DeltaRow key={j} d={d} onOpenSource={onOpenSource} />)}</div>}
              </div>
            )
          })}
        </div>
      )}
      {fuzz.questions.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">You adjudicate</div>
          {fuzz.questions.map((q, i) => <div key={i} className={qCls}>? {q}</div>)}
        </div>
      )}
      <div className={footCls}>Every input was run for real on both versions; the divergences are measured, not inferred. grasp never certifies the change safe.</div>
    </div>
  )
}
