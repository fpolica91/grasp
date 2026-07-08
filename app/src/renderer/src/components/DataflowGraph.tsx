// The observed dataflow (legacy). Interactive: plumbing collapses, evidence drills,
// input click → fuzz. Honesty grammar in markup: provenance chips, ghosted boundary,
// terminal question, no verdict. Migrated to Tailwind v4.
import { useState } from 'react'
import type { GraphModel, GraphNode, Operand } from '../../../shared/types'

const provColor: Record<string, string> = {
  observed: 'border-foreground/20 bg-foreground/5 text-foreground',
  declared: 'border-border bg-tag text-foreground-subtle',
  unknown: 'border-dashed border-border text-foreground-subtlest'
}

function OperandChip({ o, onVary }: { o: Operand; onVary?: (o: Operand) => void }): React.JSX.Element {
  return (
    <span
      className={`inline-flex cursor-default items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] ${provColor[o.provenance] ?? provColor.unknown} ${onVary ? 'cursor-pointer hover:brightness-125' : ''}`}
      title={onVary ? `fuzz ${o.name}` : o.provenance}
      onClick={onVary ? () => onVary(o) : undefined}
    >
      <span className="font-mono text-foreground-subtlest">{o.name}</span>
      <span className="font-mono">{o.display}</span>
      {onVary && <span className="text-foreground-subtlest">⋮⋮</span>}
    </span>
  )
}

function Node({ node, onVary }: { node: GraphNode; onVary?: (o: Operand) => void }): React.JSX.Element {
  const [showEvidence, setShowEvidence] = useState(false)
  const ghosted = node.presence === 'ghosted'
  const isInput = node.kind === 'input'
  return (
    <div className={`rounded-lg border bg-panel p-3 ${node.business_meaningful ? 'border-border' : 'border-border/50'} ${ghosted ? 'opacity-40 border-dashed' : ''}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] uppercase font-medium text-foreground-subtlest">{node.kind}</span>
        <span className="text-[13px] font-medium text-foreground">{node.label}</span>
        {ghosted && <span className="rounded-full border border-border px-1.5 text-[10px] text-foreground-subtlest">not observed</span>}
        {node.evidence && <button className="ml-auto text-[11px] text-foreground-subtlest underline hover:text-foreground" onClick={() => setShowEvidence((s) => !s)}>{showEvidence ? 'hide' : 'output'}</button>}
      </div>
      {node.operands.length > 0 && <div className="flex flex-wrap gap-1">{node.operands.map((o, i) => <OperandChip key={i} o={o} onVary={isInput ? onVary : undefined} />)}</div>}
      {node.question && <div className="mt-1 text-[13px] text-foreground-subtle">? {node.question}</div>}
      {showEvidence && node.evidence && <pre className="mt-2 max-h-[100px] overflow-auto whitespace-pre-wrap font-mono text-[12px] text-foreground-subtle">{node.evidence}</pre>}
    </div>
  )
}

export function DataflowGraph({ graph, onVary, varying }: { graph: GraphModel; onVary?: (o: Operand) => void; varying?: boolean }): React.JSX.Element {
  const [expandedPlumbing, setExpandedPlumbing] = useState(false)
  const t = graph.transparency
  const classifier = t.classifier_mode === 'vocab' ? `vocab · ${t.vocab_size} fields` : `non-vocab · ${t.fallback_reason ?? 'no models'}`
  const rows: React.JSX.Element[] = []
  let run = 0
  const flushRun = (key: string): void => {
    if (run === 0) return
    rows.push(<button key={`p${key}`} className="self-start rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground-subtlest hover:bg-surface-hover" onClick={() => setExpandedPlumbing(true)}>⋯ {run} plumbing step{run === 1 ? '' : 's'} — expand</button>)
    run = 0
  }
  graph.nodes.forEach((n, i) => { if (n.business_meaningful || expandedPlumbing) { flushRun(String(i)); rows.push(<Node key={n.id} node={n} onVary={onVary} />) } else { run++ } })
  flushRun('end')

  const sw = (color: string): string => `inline-block size-2 rounded-full ${color}`

  return (
    <div className={`flex h-full flex-col gap-3 overflow-y-auto p-5 ${varying ? 'opacity-60' : ''}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">observed dataflow</div>
      <h1 className="font-mono text-[16px] font-semibold text-foreground">{graph.entrypoint}</h1>
      <div className="flex flex-wrap gap-3 text-[12px] text-foreground-subtle">
        <span>mode <b className="text-foreground">{graph.mode}</b></span>
        <span>classifier <b className="text-foreground">{classifier}</b></span>
        <span>coverage <b className="text-foreground">{graph.coverage.inputs_observed} input</b></span>
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-foreground-subtlest">
        <span className="inline-flex items-center gap-1.5"><span className={sw('bg-foreground')} />observed</span>
        <span className="inline-flex items-center gap-1.5"><span className={sw('bg-tag border border-border')} />declared</span>
        <span className="inline-flex items-center gap-1.5"><span className={sw('border border-dashed border-border')} />unknown</span>
        <span className="inline-flex items-center gap-1.5"><span className={sw('border border-dashed border-foreground/30')} />not observed</span>
      </div>
      {onVary && <div className="text-[12px] text-foreground-subtle">Click an input value{varying ? ' — fuzzing…' : ''} to fuzz it.</div>}
      <div className="flex flex-col gap-2">{rows}</div>
      <div className="mt-3 rounded-lg border border-border bg-surface p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">you adjudicate</div>
        {graph.questions.length > 0 ? (
          <>
            <h2 className="mt-1 text-[14px] font-semibold text-foreground">These are questions, not findings.</h2>
            <ul className="mt-1 flex flex-col gap-1">{graph.questions.map((q, i) => (<li key={i} className="flex gap-2 text-[13px] text-foreground-subtle"><span className="text-foreground-subtlest">?</span><span>{q}</span></li>))}</ul>
          </>
        ) : <p className="mt-1 text-[12px] text-foreground-subtlest">No open question for this input. That is not a pass — it is one observed path.</p>}
      </div>
      <div className="mt-auto pt-3 text-[12px] leading-relaxed text-foreground-subtlest">Every value above is measured from one real execution or labelled <i>you supply</i>. grasp surfaces what the code did; whether it is intended is yours to say.</div>
    </div>
  )
}
