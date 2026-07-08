// The A→B change view: what the agent's edit did to behavior. Color is TEMPORAL
// (before=muted, after=signal), never good/bad. Migrated to Tailwind v4.
import type { DiffNode, GraphDiffModel, OperandDelta, Operand } from '../../../shared/types'

function Delta({ d }: { d: OperandDelta }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[12px]">
      <span className="text-foreground-subtlest">{d.field}</span>
      <span className="text-foreground-subtle line-through opacity-60">{d.old}</span>
      <span className="text-foreground-subtlest">→</span>
      <span className="text-foreground">{d.new}</span>
      <span className="text-[10px] text-foreground-subtlest">[{d.provenance}]</span>
    </div>
  )
}

const provColor: Record<string, string> = {
  observed: 'border-foreground/20 bg-foreground/5 text-foreground',
  declared: 'border-border bg-tag text-foreground-subtle',
  unknown: 'border-dashed border-border text-foreground-subtlest'
}

function Chip({ o }: { o: Operand }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] ${provColor[o.provenance] ?? provColor.unknown}`}>
      <span className="font-mono text-foreground-subtlest">{o.name}</span>
      <span className="font-mono">{o.display}</span>
    </span>
  )
}

function Node({ node }: { node: DiffNode }): React.JSX.Element {
  const ghosted = node.presence === 'ghosted'
  const statusBadge = node.status === 'added' ? 'bg-tag text-foreground' : node.status === 'removed' ? 'bg-destructive/10 text-destructive' : node.status === 'changed' ? 'bg-tag text-foreground' : 'bg-surface text-foreground-subtlest'
  return (
    <div className={`rounded-lg border border-border bg-panel p-3 ${ghosted ? 'opacity-40 border-dashed' : ''}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] uppercase font-medium text-foreground-subtlest">{node.kind}</span>
        <span className="text-[13px] font-medium text-foreground">{node.label}</span>
        <span className={`rounded px-1.5 text-[10px] uppercase ${statusBadge}`}>{node.status}</span>
      </div>
      {node.deltas.length > 0 ? (
        <div className="flex flex-col gap-0.5">{node.deltas.map((d, i) => <Delta key={i} d={d} />)}</div>
      ) : node.operands.length > 0 ? (
        <div className="flex flex-wrap gap-1">{node.operands.map((o, i) => <Chip key={i} o={o} />)}</div>
      ) : null}
    </div>
  )
}

export function DataflowDiff({ diff }: { diff: GraphDiffModel }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">dataflow change</div>
      <h1 className="font-mono text-[16px] font-semibold text-foreground">{diff.entrypoint}</h1>
      <div className="flex flex-wrap gap-3 text-[12px] text-foreground-subtle">
        <span>old <b className="text-foreground">{String(diff.old_ref)}</b></span>
        <span>new <b className="text-foreground">{String(diff.new_ref)}</b></span>
        <span>changes <b className="text-foreground">{diff.changed_count}</b></span>
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-foreground-subtlest">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2 rounded-full bg-foreground" />after — new behavior</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2 rounded-full bg-tag border border-border" />before — old behavior</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2 rounded-full border border-dashed border-foreground/30" />removed</span>
      </div>
      <div className="flex flex-col gap-2">{diff.nodes.map((n) => <Node key={n.id} node={n} />)}</div>
      {diff.empty ? (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">no behavioral change</div>
          <h2 className="mt-1 text-[14px] font-semibold text-foreground">Same dataflow for this input.</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-foreground-subtlest">{diff.honest_message}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">you adjudicate</div>
          <h2 className="mt-1 text-[14px] font-semibold text-foreground">The dataflow changed. Is this what you expected?</h2>
          <ul className="mt-1 flex flex-col gap-1">{diff.questions.map((q, i) => (<li key={i} className="flex gap-2 text-[13px] text-foreground-subtle"><span className="text-foreground-subtlest">?</span><span>{q}</span></li>))}</ul>
        </div>
      )}
      <div className="mt-auto pt-3 text-[12px] leading-relaxed text-foreground-subtlest">Old and new were each run for real under the same input; the deltas are measured, not inferred.</div>
    </div>
  )
}
