// The Flow — the product's centerpiece. Renders a grasp Trace as a navigable call tree:
// each frame shows what flowed IN (args) → the calls it made → what went OUT (return/threw).
// Frames are clickable (drill into values, jump to source); a real exception is the code's
// behavior, a tooling failure is an honest separate state — never a fake node. Ends in
// questions, never a verdict.
import { useState } from 'react'
import type { TraceDoc, TraceFrame, TraceValue, TraceDiff, FrameDelta } from '../../../shared/trace'

function Val({ v }: { v: TraceValue }): React.JSX.Element {
  return (
    <span className="fl-val">
      <span className="fl-val-k">{v.name}</span>
      <span className="fl-val-r">{v.repr}</span>
    </span>
  )
}

function Frame({
  frame,
  children,
  byParent,
  onOpenSource
}: {
  frame: TraceFrame
  children: TraceFrame[]
  byParent: Map<string | null, TraceFrame[]>
  onOpenSource?: (file: string, line: number | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(frame.depth < 1) // root expanded by default
  const kids = children
  const threw = frame.threw
  return (
    <div className={`fl-frame${threw ? ' threw' : ''}`}>
      <div className="fl-node">
        <button className="fl-caret" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={`fl-tri${open ? ' open' : ''}${kids.length ? '' : ' leaf'}`}>▸</span>
        </button>
        <div className="fl-node-main">
          <div className="fl-node-head">
            <span className="fl-fn">{frame.fn}</span>
            {frame.file && (
              <button
                className="fl-loc"
                onClick={() => onOpenSource?.(frame.file, frame.line)}
                title="open source"
              >
                {frame.file}
                {frame.line ? `:${frame.line}` : ''}
              </button>
            )}
            {frame.durMs > 0 && <span className="fl-dur">{frame.durMs.toFixed(1)}ms</span>}
          </div>
          <div className="fl-io">
            <span className="fl-io-args">
              {frame.args.length === 0 ? <span className="fl-none">no args</span> : frame.args.map((a, i) => <Val key={i} v={a} />)}
            </span>
            <span className="fl-arrow">→</span>
            {threw ? (
              <span className="fl-threw">{threw.type}: {threw.message}</span>
            ) : frame.ret ? (
              <span className="fl-ret">{frame.ret.repr}</span>
            ) : (
              <span className="fl-none">no return</span>
            )}
          </div>
          {open && threw && <div className="fl-q">? {frame.fn} threw {threw.type}: {threw.message} — intended?</div>}
        </div>
      </div>
      {open && kids.length > 0 && (
        <div className="fl-children">
          {kids.map((k) => (
            <Frame key={k.id} frame={k} children={byParent.get(k.id) ?? []} byParent={byParent} onOpenSource={onOpenSource} />
          ))}
        </div>
      )}
    </div>
  )
}

export function FlowView({
  trace,
  onOpenSource
}: {
  trace: TraceDoc
  onOpenSource?: (file: string, line: number | null) => void
}): React.JSX.Element {
  // Honest tooling-failure state — a separate surface, never a frame.
  if (trace.status === 'unobservable') {
    return (
      <div className="flow2">
        <div className="fl-head">
          <span className="fl-entry">{trace.entry}</span>
          <span className="fl-lang">{trace.language}</span>
        </div>
        <div className="fl-unobs">
          <div className="fl-unobs-t">grasp couldn&rsquo;t observe this run</div>
          <div className="fl-unobs-r">{trace.unobservable?.reason}</div>
          {trace.unobservable?.hint && <div className="fl-unobs-h">{trace.unobservable.hint}</div>}
          <div className="fl-unobs-note">
            This is a tooling gap, not the code&rsquo;s behavior — grasp will not invent a flow it didn&rsquo;t measure.
          </div>
        </div>
      </div>
    )
  }

  const byParent = new Map<string | null, TraceFrame[]>()
  for (const f of trace.frames) {
    const arr = byParent.get(f.parent) ?? []
    arr.push(f)
    byParent.set(f.parent, arr)
  }
  const roots = byParent.get(null) ?? []

  return (
    <div className="flow2">
      <div className="fl-head">
        <span className="fl-entry">{trace.entry}</span>
        <span className="fl-lang">{trace.language}</span>
        <span className="fl-meta">
          {trace.frames.length} frame{trace.frames.length === 1 ? '' : 's'}
          {trace.durationMs != null && ` · ${trace.durationMs.toFixed(1)}ms`}
        </span>
      </div>
      <div className="fl-how">ran: {trace.how}</div>

      <div className="fl-tree">
        {roots.map((r) => (
          <Frame key={r.id} frame={r} children={byParent.get(r.id) ?? []} byParent={byParent} onOpenSource={onOpenSource} />
        ))}
      </div>

      {(trace.stdout || trace.stderr) && (
        <details className="fl-output">
          <summary>observed output</summary>
          {trace.stdout && <pre>{trace.stdout}</pre>}
          {trace.stderr && <pre className="err">{trace.stderr}</pre>}
        </details>
      )}

      <div className="fl-foot">
        Every value above is measured from one real execution — nothing inferred. grasp surfaces what the code did;
        whether it is intended is yours to say.
      </div>
    </div>
  )
}


// ── A→B diff view: the same call tree, with changed / added / removed frames ───
function DeltaRow({ d, onOpenSource }: { d: FrameDelta; onOpenSource?: (file: string, line: number | null) => void }): React.JSX.Element {
  const f = d.frame
  return (
    <div className={`fl-frame fl-d-${d.status}`} style={{ marginLeft: f.depth * 16 }}>
      <div className="fl-node">
        <div className="fl-node-main">
          <div className="fl-node-head">
            <span className={`fl-badge ${d.status}`}>{d.status}</span>
            <span className="fl-fn">{f.fn}</span>
            {f.file && (
              <button className="fl-loc" onClick={() => onOpenSource?.(f.file, f.line)} title="open source">
                {f.file}{f.line ? `:${f.line}` : ''}
              </button>
            )}
          </div>
          {d.status === 'changed' ? (
            <div className="fl-deltas">
              {d.changes.map((c, i) => (
                <div className="fl-delta" key={i}>
                  <span className="fl-delta-k">{c.name === '→return' ? 'return' : c.name}</span>
                  <span className="fl-delta-old">{c.old}</span>
                  <span className="fl-arrow">→</span>
                  <span className="fl-delta-new">{c.new}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="fl-io">
              <span className="fl-io-args">
                {f.args.length === 0 ? <span className="fl-none">no args</span> : f.args.map((a, i) => <Val key={i} v={a} />)}
              </span>
              <span className="fl-arrow">→</span>
              {f.threw ? <span className="fl-threw">{f.threw.type}</span> : f.ret ? <span className="fl-ret">{f.ret.repr}</span> : <span className="fl-none">void</span>}
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
    <div className="flow2">
      <div className="fl-head">
        <span className="fl-entry">{diff.entry}</span>
        <span className="fl-lang">A→B</span>
        <span className="fl-meta">{diff.oldRef ?? 'old'} → {diff.newRef ?? 'new'} · {diff.changedCount} change{diff.changedCount === 1 ? '' : 's'}</span>
      </div>
      {diff.empty ? (
        <div className="fl-unobs" style={{ borderStyle: 'solid' }}>
          <div className="fl-unobs-t">Same flow for this input.</div>
          <div className="fl-unobs-note">Both versions ran the same call tree with the same values. That is not a pass — it is one observed path.</div>
        </div>
      ) : (
        <>
          <div className="fl-tree">
            {rows.map((d, i) => <DeltaRow key={i} d={d} onOpenSource={onOpenSource} />)}
          </div>
          <button className="fl-toggle-unchanged" onClick={() => setShowUnchanged((v) => !v)}>
            {showUnchanged ? 'hide unchanged frames' : `show ${diff.frames.filter((f) => f.status === 'unchanged').length} unchanged`}
          </button>
          {diff.questions.length > 0 && (
            <div className="fl-qpanel">
              <div className="fl-qpanel-t">You adjudicate</div>
              {diff.questions.map((q, i) => <div className="fl-q" key={i}>? {q}</div>)}
            </div>
          )}
        </>
      )}
      <div className="fl-foot">Old and new were each run for real under the same input; the deltas are measured, not inferred. grasp does not label the change correct or incorrect — that is yours to say.</div>
    </div>
  )
}

