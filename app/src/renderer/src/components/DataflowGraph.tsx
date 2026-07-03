// The observed dataflow — now interactive (S1d). Plumbing collapses by default and
// expands on click; a node's observed evidence drills down; and clicking an INPUT
// operand fuzzes that input to expose edge cases — fusing flow + fuzz into one object.
// The honesty grammar still lives in the markup: provenance chips, ghosted coverage
// boundary, terminal question, no verdict.
import { useState } from 'react'
import type { GraphModel, GraphNode, Operand } from '../../../shared/types'

function OperandChip({ o, onVary }: { o: Operand; onVary?: (o: Operand) => void }): React.JSX.Element {
  const clickable = !!onVary
  return (
    <span
      className={`op op-${o.provenance}${clickable ? ' clickable' : ''}`}
      title={clickable ? `fuzz ${o.name} to find edge cases` : o.provenance}
      onClick={clickable ? () => onVary(o) : undefined}
    >
      <span className="op-k">{o.name}</span>
      <span className="op-v">{o.display}</span>
      {clickable && <span className="op-vary">⋮⋮</span>}
    </span>
  )
}

function Node({ node, onVary }: { node: GraphNode; onVary?: (o: Operand) => void }): React.JSX.Element {
  const [showEvidence, setShowEvidence] = useState(false)
  const cls = ['node', node.business_meaningful ? 'business' : 'plumbing']
  if (node.presence === 'ghosted') cls.push('ghosted')
  const isInput = node.kind === 'input'
  return (
    <div className={cls.join(' ')}>
      <div className="card">
        <div className="chead">
          <span className="kind">{node.kind}</span>
          <span className="lbl">{node.label}</span>
          {node.presence === 'ghosted' && <span className="gtag">not observed here</span>}
          {node.evidence && (
            <button className="ev-toggle" onClick={() => setShowEvidence((s) => !s)}>
              {showEvidence ? 'hide output' : 'output'}
            </button>
          )}
        </div>
        {node.operands.length > 0 && (
          <div className="ops">
            {node.operands.map((o, i) => (
              <OperandChip key={i} o={o} onVary={isInput ? onVary : undefined} />
            ))}
          </div>
        )}
        {node.question && <div className="qflag">? {node.question}</div>}
        {showEvidence && node.evidence && <pre className="evidence">{node.evidence}</pre>}
      </div>
    </div>
  )
}

export function DataflowGraph({
  graph,
  onVary,
  varying
}: {
  graph: GraphModel
  onVary?: (o: Operand) => void
  varying?: boolean
}): React.JSX.Element {
  const [expandedPlumbing, setExpandedPlumbing] = useState(false)
  const t = graph.transparency
  const classifier =
    t.classifier_mode === 'vocab' ? `vocab · ${t.vocab_size} fields` : `non-vocab · ${t.fallback_reason ?? 'no models found'}`

  // Collapse runs of non-business (plumbing) nodes into one expandable marker.
  const rows: React.JSX.Element[] = []
  let run = 0
  const flushRun = (key: string): void => {
    if (run === 0) return
    rows.push(
      <button key={`p${key}`} className="plumbing-toggle" onClick={() => setExpandedPlumbing(true)}>
        ⋯ {run} plumbing step{run === 1 ? '' : 's'} — expand
      </button>
    )
    run = 0
  }
  graph.nodes.forEach((n, i) => {
    if (n.business_meaningful || expandedPlumbing) {
      flushRun(String(i))
      rows.push(<Node key={n.id} node={n} onVary={onVary} />)
    } else {
      run++
    }
  })
  flushRun('end')

  return (
    <div className={`flow${varying ? ' varying' : ''}`}>
      <div className="eyebrow">observed dataflow</div>
      <h1 className="fentry">{graph.entrypoint}</h1>
      <div className="readout">
        <span>
          mode <b>{graph.mode}</b>
        </span>
        <span>
          classifier <b>{classifier}</b>
        </span>
        <span>
          coverage <b>{graph.coverage.inputs_observed} input</b>
        </span>
      </div>

      <div className="legend">
        <span className="li"><span className="sw observed" />observed — measured this run</span>
        <span className="li"><span className="sw declared" />declared — read from source</span>
        <span className="li"><span className="sw unknown" />you supply — a blank, not a fact</span>
        <span className="li"><span className="sw ghost" />not observed — coverage boundary</span>
      </div>
      {onVary && <div className="vary-hint">Click an input value{varying ? ' — fuzzing…' : ''} to fuzz it and surface edge cases.</div>}

      <div className="spine">{rows}</div>

      <div className="qpanel">
        <div className="eyebrow q">you adjudicate</div>
        {graph.questions.length > 0 ? (
          <>
            <h2>These are questions, not findings.</h2>
            <ul className="qlist">
              {graph.questions.map((q, i) => (
                <li key={i}>
                  <span className="mark">?</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="empty">No open question surfaced for this input. That is not a pass — it is one observed path.</p>
        )}
      </div>

      <div className="foot">
        Every value above is measured from one real execution or labelled <i>you supply</i> — nothing is inferred.
        grasp surfaces what the code did; whether it is intended is yours to say.
      </div>
    </div>
  )
}
