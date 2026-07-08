// The Flow — grasp's centerpiece. Renders a Trace as a navigable call tree.
// Fully migrated to Tailwind v4 with @theme tokens.
import { useState } from 'react'
import type { TraceDoc, TraceFrame, TraceValue, TraceDiff, FrameDelta, FuzzDiff } from '../../../shared/trace'
import type { ModelReport } from '../../../shared/model'
import type { IntroDoc } from '../../../shared/types'

// ── Value rendering: business objects, TRANSFORMATIONS, and LINEAGE ──────────
// The reader follows the object BETWEEN frames, not JSON at each one: an exact repeat
// renders as a reference, a descendant (same object, mutated) renders as a delta
// against its ancestor, nested objects recurse, opaque payloads read as sizes.

interface AncestorDelta {
  label: string
  from: Record<string, unknown>
}
interface Occ {
  first: boolean
  label: string
  ancestor?: AncestorDelta
  childAncestors?: Record<string, AncestorDelta>
}
type OccMap = Map<string, Occ>

function Str({ s }: { s: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (s.length <= 96) return <>{s}</>
  const opaque = !/\s/.test(s)
  return (
    <>
      {open ? s : opaque ? s.slice(0, 28) + '…' : s.slice(0, 96) + '…'}
      <button className="ml-1 border-0 bg-transparent p-0 font-mono text-[10px] text-foreground-subtlest underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'less' : `⟨${s.length} chars⟩`}
      </button>
    </>
  )
}

const isStructured = (j: unknown): j is Record<string, unknown> | unknown[] => j !== null && typeof j === 'object'
const isPlainObj = (j: unknown): j is Record<string, unknown> => isStructured(j) && !Array.isArray(j)
const primRepr = (x: unknown): string => {
  const s = JSON.stringify(x)
  return s === undefined ? String(x) : s
}
function parseJsonString(j: unknown): Record<string, unknown> | unknown[] | null {
  if (typeof j !== 'string') return null
  const t = j.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    const p = JSON.parse(t)
    return isStructured(p) ? p : null
  } catch {
    return null
  }
}
function structOf(v: TraceValue): Record<string, unknown> | unknown[] | null {
  return isStructured(v.json) ? v.json : parseJsonString(v.json)
}

// Lineage: the closest earlier object sharing enough identical key:values is this
// value's ancestor — computed from observed data only, never guessed. ≥half the keys
// (and at least 3) must match exactly.
function bestAncestor(obj: Record<string, unknown>, priors: { label: string; obj: Record<string, unknown> }[]): AncestorDelta | undefined {
  let best: AncestorDelta | undefined
  let bestScore = 0
  for (const p of priors) {
    const keys = new Set([...Object.keys(obj), ...Object.keys(p.obj)])
    let shared = 0
    for (const k of keys) if (k in obj && k in p.obj && JSON.stringify(obj[k]) === JSON.stringify(p.obj[k])) shared++
    const ratio = shared / keys.size
    if (shared >= 3 && ratio >= 0.5 && ratio > bestScore) {
      bestScore = ratio
      best = { label: p.label, from: p.obj }
    }
  }
  return best
}

function buildOcc(frames: TraceFrame[]): OccMap {
  const seenAt = new Map<string, string>()
  const priors: { label: string; obj: Record<string, unknown> }[] = []
  const occ: OccMap = new Map()
  const register = (j: Record<string, unknown> | unknown[], label: string): void => {
    const key = JSON.stringify(j)
    if (!seenAt.has(key)) {
      seenAt.set(key, label)
      if (isPlainObj(j)) priors.push({ label, obj: j })
    }
  }
  const slotOcc = (j: Record<string, unknown> | unknown[], label: string): Occ => {
    const key = JSON.stringify(j)
    const prior = seenAt.get(key)
    if (prior) return { first: false, label: prior }
    const o: Occ = { first: true, label }
    const noteChild = (path: string, val: unknown): void => {
      if (!isPlainObj(val)) return
      const exact = seenAt.get(JSON.stringify(val))
      const anc = exact ? { label: exact, from: val } : bestAncestor(val, priors)
      if (anc) {
        o.childAncestors = o.childAncestors ?? {}
        o.childAncestors[path] = anc
      }
    }
    if (isPlainObj(j)) {
      o.ancestor = bestAncestor(j, priors)
      for (const [k, val] of Object.entries(j)) {
        noteChild(k, val)
        // arrays of objects are the common shape of app state (task lists) — track lineage per element
        if (Array.isArray(val)) val.forEach((el, idx) => noteChild(`${k}.${idx}`, el))
      }
    } else if (Array.isArray(j)) {
      // a BARE array slot (an arg or return that IS the list) tracks lineage per element too
      j.forEach((el, idx) => noteChild(String(idx), el))
    }
    return o
  }
  // CHRONOLOGICAL walk, not entry-order: a frame's args exist at ENTRY, but its return
  // exists only at EXIT — after every child ran. Registering a parent's return before its
  // children made the renderer describe inputs as mutations of objects that did not exist
  // yet (causally inverted lineage — observed in the wild on handleAddTask).
  const byParent = new Map<string | null, TraceFrame[]>()
  for (const f of frames) {
    const arr = byParent.get(f.parent) ?? []
    arr.push(f)
    byParent.set(f.parent, arr)
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.seq - b.seq)
  const visit = (f: TraceFrame): void => {
    f.args.forEach((arg, i) => {
      const j = structOf(arg)
      if (!j) return
      occ.set(`${f.id}:arg:${i}`, slotOcc(j, `${arg.name} @ ${f.fn}`))
      register(j, `${arg.name} @ ${f.fn}`)
      if (isPlainObj(j))
        for (const [k, val] of Object.entries(j)) {
          if (isPlainObj(val)) register(val, `${arg.name}.${k} @ ${f.fn}`)
          if (Array.isArray(val)) val.forEach((el, idx) => { if (isPlainObj(el)) register(el, `${arg.name}.${k}.${idx} @ ${f.fn}`) })
        }
      if (Array.isArray(j)) j.forEach((el, idx) => { if (isPlainObj(el)) register(el, `${arg.name}.${idx} @ ${f.fn}`) })
    })
    for (const child of byParent.get(f.id) ?? []) visit(child)
    if (f.ret) {
      const j = structOf(f.ret)
      if (j) {
        occ.set(`${f.id}:ret`, slotOcc(j, `return of ${f.fn}`))
        register(j, `return of ${f.fn}`)
        if (isPlainObj(j))
          for (const [k, val] of Object.entries(j)) {
            if (isPlainObj(val)) register(val, `return.${k} of ${f.fn}`)
            if (Array.isArray(val)) val.forEach((el, idx) => { if (isPlainObj(el)) register(el, `return.${k}.${idx} of ${f.fn}`) })
          }
        if (Array.isArray(j)) j.forEach((el, idx) => { if (isPlainObj(el)) register(el, `return.${idx} of ${f.fn}`) })
      }
    }
  }
  for (const root of byParent.get(null) ?? []) visit(root)
  return occ
}

// The transformation, not two payloads: removed / added / changed keys against the
// ancestor, unchanged count collapsed, full object one click away. An empty delta
// renders as pure reference. Facts only — nothing here judges the change.
function DeltaBlock({ from, to, vs }: { from: Record<string, unknown>; to: Record<string, unknown>; vs?: string }): React.JSX.Element {
  const removed = Object.keys(from).filter((k) => !(k in to))
  const added = Object.keys(to).filter((k) => !(k in from))
  const changed = Object.keys(to).filter((k) => k in from && JSON.stringify(to[k]) !== JSON.stringify(from[k]))
  const unchanged = Object.keys(to).filter((k) => k in from && !changed.includes(k)).length
  if (!removed.length && !added.length && !changed.length) {
    return (
      <details className="my-0.5 min-w-0">
        <summary className="cursor-pointer list-none font-mono text-[11px] text-foreground-subtlest">= same as <span className="text-foreground-subtle">{vs ?? 'the input'}</span> ▸</summary>
        <ObjView j={to} />
      </details>
    )
  }
  return (
    <div className="my-0.5 flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-panel px-2 py-1">
      {vs && <span className="font-mono text-[10px] text-foreground-subtlest">vs {vs}</span>}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11.5px]">
        {removed.map((k) => (
          <span key={'r' + k} className="text-foreground-subtlest line-through">− {k}</span>
        ))}
        {added.map((k) => (
          <span key={'a' + k} className="text-foreground">
            + {k} <span className="text-foreground-subtle"><Str s={primRepr(to[k])} /></span>
          </span>
        ))}
        {changed.map((k) => (
          <span key={'c' + k} className="text-foreground">
            {k} <span className="text-foreground-subtlest line-through"><Str s={primRepr(from[k])} /></span> → <Str s={primRepr(to[k])} />
          </span>
        ))}
        {unchanged > 0 && <span className="text-foreground-subtlest">· {unchanged} unchanged</span>}
      </div>
      <details className="min-w-0">
        <summary className="cursor-pointer list-none text-[10px] text-foreground-subtlest">full object ▸</summary>
        <ObjView j={to} />
      </details>
    </div>
  )
}

function ObjView({ j, badge, childAnc, depth = 0 }: { j: Record<string, unknown> | unknown[]; badge?: string; childAnc?: Record<string, AncestorDelta>; depth?: number }): React.JSX.Element {
  const entries: [string, unknown][] = Array.isArray(j) ? j.map((v, i) => [String(i), v] as [string, unknown]) : Object.entries(j)
  return (
    <div className="my-0.5 flex min-w-0 flex-col gap-px rounded-md border border-border bg-panel px-2 py-1">
      {badge && <span className="text-[9px] uppercase tracking-wide text-foreground-subtlest">{badge}</span>}
      {entries.slice(0, 24).map(([k, val], i) => {
        const anc = childAnc?.[k]
        if (anc && isPlainObj(val))
          return (
            <div key={i} className="flex min-w-0 items-start gap-1.5 font-mono text-[11.5px]">
              <span className="shrink-0 pt-1 text-foreground-subtlest">{k}</span>
              <DeltaBlock from={anc.from} to={val} vs={anc.label} />
            </div>
          )
        if (isStructured(val) && depth < 2) {
          const scopedEntries = childAnc
            ? Object.entries(childAnc).filter(([kk]) => kk.startsWith(k + '.')).map(([kk, v2]) => [kk.slice(k.length + 1), v2] as [string, AncestorDelta])
            : []
          return (
            <div key={i} className="flex min-w-0 items-start gap-1.5 font-mono text-[11.5px]">
              <span className="shrink-0 pt-1 text-foreground-subtlest">{k}</span>
              <ObjView j={val} depth={depth + 1} childAnc={scopedEntries.length ? Object.fromEntries(scopedEntries) : undefined} />
            </div>
          )
        }
        return (
          <div key={i} className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px]">
            <span className="shrink-0 text-foreground-subtlest">{k}</span>
            <span className="min-w-0 break-all text-foreground"><Str s={primRepr(val)} /></span>
          </div>
        )
      })}
      {entries.length > 24 && <span className="text-[10px] text-foreground-subtlest">…+{entries.length - 24} more</span>}
    </div>
  )
}

function StructVal({ j, occ, badge }: { j: Record<string, unknown> | unknown[]; occ?: Occ; badge?: string }): React.JSX.Element {
  if (occ && !occ.first) {
    return (
      <details className="my-0.5 min-w-0">
        <summary className="cursor-pointer list-none font-mono text-[11px] text-foreground-subtlest">
          = same as <span className="text-foreground-subtle">{occ.label}</span> ▸
        </summary>
        <ObjView j={j} badge={badge} />
      </details>
    )
  }
  if (occ?.ancestor && isPlainObj(j)) return <DeltaBlock from={occ.ancestor.from} to={j} vs={occ.ancestor.label} />
  return <ObjView j={j} badge={badge} childAnc={occ?.childAncestors} />
}

function Val({ v, occ }: { v: TraceValue; occ?: Occ }): React.JSX.Element {
  const j = structOf(v)
  if (j) {
    return (
      <div className="flex w-full min-w-0 items-start gap-1.5">
        <span className="shrink-0 pt-1 font-mono text-[12px] text-foreground-subtlest">{v.name}</span>
        <StructVal j={j} occ={occ} badge={!isStructured(v.json) ? 'json in a string' : undefined} />
      </div>
    )
  }
  return (
    <span className="inline-flex max-w-full items-baseline gap-1">
      <span className="font-mono text-[12px] text-foreground-subtlest">{v.name}</span>
      <span className="min-w-0 break-all font-mono text-[12px] text-foreground"><Str s={v.repr} /></span>
    </span>
  )
}

function RetView({ frame, occ }: { frame: TraceFrame; occ?: OccMap }): React.JSX.Element {
  const ret = frame.ret as TraceValue
  const retJson = structOf(ret)
  const o = occ?.get(`${frame.id}:ret`)
  if (retJson) {
    return (
      <div className="w-full min-w-0">
        <StructVal j={retJson} occ={o} badge={!isStructured(ret.json) ? 'json in a string' : undefined} />
      </div>
    )
  }
  return <span className="min-w-0 break-all text-foreground-subtle"><Str s={ret.repr} /></span>
}

function Frame({ frame, children, byParent, onOpenSource, occ }: {
  frame: TraceFrame; children: TraceFrame[]
  byParent: Map<string | null, TraceFrame[]>
  onOpenSource?: (file: string, line: number | null) => void
  occ?: OccMap
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
              {frame.args.length === 0 ? <span className="italic text-foreground-subtlest">no args</span> : frame.args.map((a, i) => <Val key={i} v={a} occ={occ?.get(`${frame.id}:arg:${i}`)} />)}
            </span>
            <span className="text-foreground-subtlest">→</span>
            {threw ? (
              <span className="text-destructive">{threw.type}: {threw.message}</span>
            ) : frame.ret ? (
              <RetView frame={frame} occ={occ} />
            ) : (
              <span className="italic text-foreground-subtlest">no return</span>
            )}
          </div>
          {open && threw && <div className="mt-1 text-[13px] text-foreground-subtle">? {frame.fn} threw {threw.type}: {threw.message} — intended?</div>}
        </div>
      </div>
      {open && children.length > 0 && (
        <div className="ml-4 border-l border-border pl-3">
          {children.map((k) => (<Frame key={k.id} frame={k} children={byParent.get(k.id) ?? []} byParent={byParent} onOpenSource={onOpenSource} occ={occ} />))}
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
  const occ = buildOcc(trace.frames)
  return (
    <div className={shellCls}>
      <div className="flex items-center gap-2">
        <span className={headEntry}>{trace.entry}</span>
        <span className={headLang}>{trace.language}</span>
        {trace.observation && (
          <span className={headLang} title="how this run was observed">
            {trace.observation.channel}
            {trace.observation.channel === 'runner' && trace.observation.appAttempt
              ? trace.observation.appAttempt.attempted
                ? ' · app attach failed'
                : trace.observation.appAttempt.reason === 'deferred-heavyweight'
                  ? ` · app deferred — boots with: ${trace.observation.appAttempt.path ?? '?'}`
                  : ` · app not attempted: ${trace.observation.appAttempt.reason ?? 'unreasoned'}`
              : ''}
          </span>
        )}
        <span className={headMeta}>{trace.frames.length} frame{trace.frames.length === 1 ? '' : 's'}{trace.durationMs != null && ` · ${trace.durationMs.toFixed(1)}ms`}</span>
      </div>
      {trace.how.length > 90 ? (
        <details className="text-[12px] text-foreground-subtlest">
          <summary className="cursor-pointer list-none">ran: {trace.how.slice(0, 90)}… <span className="underline">more</span></summary>
          <div className="mt-0.5 leading-relaxed">{trace.how}</div>
        </details>
      ) : (
        <div className="text-[12px] text-foreground-subtlest">ran: {trace.how}</div>
      )}
      <div className="flex flex-col">
        {roots.map((r) => (<Frame key={r.id} frame={r} children={byParent.get(r.id) ?? []} byParent={byParent} onOpenSource={onOpenSource} occ={occ} />))}
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
      {diff.rootChange && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[13px]">
          <span className="text-destructive line-through opacity-70">{diff.rootChange.old}</span>
          <span className="mx-1.5 text-foreground-subtlest">→</span>
          <span className="text-foreground">{diff.rootChange.new}</span>
        </div>
      )}
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

// The workspace introduction: deterministic layout, typed slots, rules straight from the
// model file. Flow rows are one click from a real observation.
export function IntroView({ intro, onPickFlow }: { intro: IntroDoc; onPickFlow?: (name: string) => void }): React.JSX.Element {
  const chip = (s: string): string => (s === 'staged' ? 'text-foreground-subtlest' : s === 'uncompiled' ? 'text-foreground-subtle' : 'text-foreground')
  return (
    <div className={shellCls}>
      <div className="flex items-center gap-2">
        <span className={headEntry}>this workspace</span>
        <span className={headLang}>introduction</span>
      </div>
      <div className="rounded-xl border border-border bg-surface p-3 text-[13px] leading-relaxed text-foreground">{intro.how}</div>
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">flows you can ask to see</div>
        <div className="mt-1 flex flex-col">
          {intro.flows.map((f, i) => (
            <button key={i} className="flex items-baseline gap-2 border-t border-border bg-transparent px-1 py-1.5 text-left first:border-t-0 hover:bg-surface-hover" onClick={() => onPickFlow?.(f.name)}>
              <span className="text-[13px] font-medium text-foreground">{f.name}</span>
              <span className="min-w-0 text-[12px] text-foreground-subtle">{f.what}</span>
              <span className="ml-auto shrink-0 text-[11px] text-foreground-subtlest">show ▸</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">rules in your model</div>
        {intro.rules.length === 0 ? (
          <div className="py-1 text-[12px] text-foreground-subtlest">none found at {intro.workspace}/.grasp/model.yaml — state an always/never in chat and it will be staged for your signature there</div>
        ) : (
          <div className="mt-1 flex flex-col">
            {intro.rules.map((r) => (
              <div key={r.id} className="flex items-baseline gap-2 border-t border-border py-1.5 first:border-t-0">
                <span className="font-mono text-[11px] text-foreground-subtlest">{r.id}</span>
                <span className="min-w-0 text-[13px] text-foreground">{r.text}</span>
                <span className={`ml-auto shrink-0 font-mono text-[11px] ${chip(r.status)}`}>{r.status}</span>
              </div>
            ))}
          </div>
        )}
        {intro.rules.some((r) => r.status === 'staged') && (
          <div className="mt-1.5 text-[11px] leading-relaxed text-foreground-subtlest">staged = harvested from your docs, awaiting you: delete its staged flag in .grasp/model.yaml to enforce, or delete the rule.</div>
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-foreground-subtle">next: {intro.suggestion}</div>
    </div>
  )
}

// The Verification Report (spec-v2 §1.6): one row per rule, four words only. "violated"
// replays the human's own ratified judgment — grasp adds none. Novel rows are the only
// ones that ask.
function ReportView({ report, onAdjudicate }: { report: ModelReport; onAdjudicate?: (prompt: string) => void }): React.JSX.Element {
  const statusCls = (s: string): string =>
    s === 'violated' ? 'text-destructive' : s === 'conforms' ? 'text-foreground' : 'text-foreground-subtlest'
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">
        verification report{report.feature ? ` — ${report.feature}` : ''}
      </div>
      <div className="mt-1.5 flex flex-col">
        {report.rows.filter((r) => !r.note?.startsWith('staged')).map((r) => (
          <div key={r.id} className="border-t border-border py-1.5 first:border-t-0">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <span className="mr-2 font-mono text-[11px] text-foreground-subtlest">{r.id}</span>
                <span className="text-[13px] text-foreground">{r.text}</span>
              </div>
              <span className={`shrink-0 font-mono text-[12px] ${statusCls(r.status)}`}>
                {r.status}
                {r.status !== 'untested' && ` (${r.covered} case${r.covered === 1 ? '' : 's'})`}
              </span>
            </div>
            <div className="text-[11px] text-foreground-subtlest">
              {r.origin === 'ratified' ? `ratified ${r.ratified ?? ''}` : r.origin}
              {r.note ? ` · ${r.note}` : ''}
            </div>
            {r.counterexamples.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5">
                {r.counterexamples.map((c, i) => (
                  <div key={i} className="font-mono text-[12px] text-foreground-subtle">
                    {c.label ?? JSON.stringify(c.input)} — observed: {c.observed}
                  </div>
                ))}
                {onAdjudicate && (
                  <div className="mt-0.5 flex gap-1.5">
                    <button className="rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover" onClick={() => onAdjudicate(`Rule ${r.id} ("${r.text}") is violated — see counterexample "${r.counterexamples[0]?.label ?? 'above'}". Repair the code to satisfy the rule and re-verify with grasp_fuzz_diff.`)}>repair the code ▸</button>
                    <button className="rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground-subtlest hover:bg-surface-hover" onClick={() => onAdjudicate(`Rule ${r.id} ("${r.text}") no longer reflects my intent. Based on the observed behavior, propose an amended rule text staged for my confirmation, and leave the code as is.`)}>amend the rule ▸</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {report.rows.length === 0 && <div className="py-1 text-[12px] text-foreground-subtlest">model has no rules yet</div>}
        {report.rows.some((r) => r.note?.startsWith('staged')) && (
          <details className="border-t border-border py-1.5">
            <summary className="cursor-pointer list-none text-[12px] text-foreground-subtle">
              {report.rows.filter((r) => r.note?.startsWith('staged')).length} staged — awaiting your signature in model.yaml (delete the staged flag to enforce) ▸
            </summary>
            <div className="mt-1 flex flex-col gap-0.5">
              {report.rows.filter((r) => r.note?.startsWith('staged')).map((r) => (
                <div key={r.id} className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-foreground-subtlest">{r.id}</span>
                  <span className="min-w-0 truncate text-[12px] text-foreground-subtle">{r.text}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      {report.novel.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">novel — no rule covers these</div>
          {report.novel.map((n, i) => (
            <div key={i}>
              <div className={qCls}>? {n.label ?? JSON.stringify(n.input)}: {n.change} — intended?</div>
              {onAdjudicate && (
                <div className="mb-1 mt-0.5 flex gap-1.5">
                  <button className="rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover" onClick={() => onAdjudicate(`The novel behavior "${n.label ?? JSON.stringify(n.input)}" (${n.change}) is INTENDED. Stage it into .grasp/model.yaml as a ratified rule per the behavior-model skill, with this fuzz run as evidence.`)}>intended — remember it ▸</button>
                  <button className="rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground-subtlest hover:bg-surface-hover" onClick={() => onAdjudicate(`The novel behavior "${n.label ?? JSON.stringify(n.input)}" (${n.change}) is NOT intended. Repair the code so it no longer occurs, re-verify with grasp_fuzz_diff, and propose a staged rule preventing regression.`)}>not intended — repair ▸</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 text-[11px] leading-relaxed text-foreground-subtlest">{report.scope}</div>
    </div>
  )
}

export function FuzzDiffView({ fuzz, onOpenSource, onAdjudicate }: { fuzz: FuzzDiff; onOpenSource?: (file: string, line: number | null) => void; onAdjudicate?: (prompt: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className={shellCls}>
      <div className="flex items-center gap-2">
        <span className={headEntry}>{fuzz.entry}</span>
        <span className={headLang}>fuzz A→B</span>
        <span className={headMeta}>{fuzz.oldRef ?? 'old'} → {fuzz.newRef ?? 'new'} · {fuzz.tried} tried · {fuzz.diverged} diverged</span>
      </div>
      {fuzz.report && <ReportView report={fuzz.report} onAdjudicate={onAdjudicate} />}
      {fuzz.claim && (
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">behavioral delta — agent proposed · grasp checked</div>
          <div className="mt-1.5 font-mono text-[13px] text-foreground">
            where {fuzz.claim.rendered}
            {fuzz.claim.effectRendered && <span className="text-foreground-subtle">: {fuzz.claim.effectRendered}</span>}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-foreground-subtle">{fuzz.claim.summary}</div>
          {fuzz.claim.mismatches.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5 border-t border-border pt-1.5">
              {fuzz.claim.mismatches.map((m, i) => (
                <div key={i} className="font-mono text-[12px] text-foreground-subtle">
                  {JSON.stringify(m.input)} — observed {m.observed}, claim said {m.claimed}
                </div>
              ))}
              {fuzz.claim.mismatchCount > fuzz.claim.mismatches.length && (
                <div className="text-[11px] text-foreground-subtlest">+{fuzz.claim.mismatchCount - fuzz.claim.mismatches.length} more mismatches</div>
              )}
            </div>
          )}
        </div>
      )}
      {fuzz.axes && (fuzz.axes.varied.length > 0 || fuzz.axes.held.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {fuzz.axes.varied.length > 0 && <span className="text-[11px] text-foreground-subtlest">varied</span>}
          {fuzz.axes.varied.map((a, i) => (
            <span key={`v${i}`} className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-foreground-subtle">
              {a.path}
              {a.note ? ` ${a.note}` : ''} · {a.distinct} observed
            </span>
          ))}
          {fuzz.axes.held.length > 0 && <span className="text-[11px] text-foreground-subtlest">held constant</span>}
          {fuzz.axes.held.map((h, i) => (
            <span key={`h${i}`} className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[11px] text-foreground-subtlest">
              {h.path} = {h.repr}
              {h.constant ? '' : ' · not constant in the cases'}
            </span>
          ))}
        </div>
      )}
      {fuzz.axes && fuzz.axes.issues.length > 0 && (
        <div className="flex flex-col gap-0.5 text-[12px] text-foreground-subtle">
          {fuzz.axes.issues.map((s, i) => (
            <div key={i}>{s}</div>
          ))}
        </div>
      )}
      {!fuzz.report && (
        <div className="rounded-lg bg-surface px-3 py-1.5 text-[13px] text-foreground-subtle">{fuzz.scope}</div>
      )}
      {fuzz.outcomes.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">scenarios — outcomes in domain words · frames are the drill-down</div>
          {[...new Set(fuzz.outcomes.map((o) => o.scenario ?? '(unnamed scenario)'))].map((sc) => {
            const rows = fuzz.outcomes.filter((o) => (o.scenario ?? '(unnamed scenario)') === sc)
            const changed = rows.filter((o) => !o.same)
            const sames = rows.filter((o) => o.same)
            return (
              <div key={sc} className="mt-1.5 border-t border-border pt-1.5 first:mt-0 first:border-t-0 first:pt-0">
                <div className="font-mono text-[11px] text-foreground-subtlest">{sc}</div>
                {changed.map((o, i) => {
                  const dv = fuzz.cases.find((c) => (o.label ? c.label === o.label : JSON.stringify(c.input) === JSON.stringify(o.input)))
                  const frames = dv ? dv.diff.frames.filter((f) => f.status !== 'unchanged') : []
                  return (
                    <details key={i} className="py-0.5">
                      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[13px] text-foreground">{o.label ?? JSON.stringify(o.input).slice(0, 60)}</span>
                        <span className="font-mono text-[12px]"><span className="text-destructive line-through opacity-70">{o.old}</span><span className="mx-1 text-foreground-subtlest">→</span><span className="text-foreground">{o.new}</span></span>
                        {frames.length > 0 && <span className="text-[10px] text-foreground-subtlest">{frames.length} frame(s) ▸</span>}
                      </summary>
                      {dv && frames.length > 0 && (
                        <div className="mt-1 border-l border-border pl-2">{frames.map((d, j) => <DeltaRow key={j} d={d} onOpenSource={onOpenSource} />)}</div>
                      )}
                    </details>
                  )
                })}
                {sames.length > 0 && (
                  <details className="py-0.5">
                    <summary className="cursor-pointer list-none text-[12px] text-foreground-subtlest">· {sames.length} unchanged ▸</summary>
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {sames.map((o, i) => (
                        <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-foreground-subtle">
                          <span>{o.label ?? JSON.stringify(o.input).slice(0, 60)}</span>
                          <span className="font-mono text-[11px] text-foreground-subtlest">{o.new}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
      {fuzz.questions.length > 0 && !fuzz.report && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtlest">You adjudicate</div>
          {fuzz.questions.map((q, i) => <div key={i} className={qCls}>? {q}</div>)}
        </div>
      )}
      <div className={footCls}>Every input was run for real on both versions; the divergences are measured, not inferred. grasp never certifies the change safe.</div>
    </div>
  )
}
