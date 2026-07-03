// The differentiator, as a native React component: the observed dataflow. It renders
// the engine's graph contract with the honesty grammar intact — provenance in chip
// form, the ghosted coverage boundary, a terminal question, and NO verdict. A
// beautiful UI must not become a liar, so the grammar lives here, in the markup.
import type { GraphModel, GraphNode, Operand } from '../../../shared/types'

function OperandChip({ o }: { o: Operand }): React.JSX.Element {
  return (
    <span className={`op op-${o.provenance}`} title={o.provenance}>
      <span className="op-k">{o.name}</span>
      <span className="op-v">{o.display}</span>
    </span>
  )
}

function Node({ node }: { node: GraphNode }): React.JSX.Element {
  const cls = ['node', node.business_meaningful ? 'business' : 'plumbing']
  if (node.presence === 'ghosted') cls.push('ghosted')
  return (
    <div className={cls.join(' ')}>
      <div className="card">
        <div className="chead">
          <span className="kind">{node.kind}</span>
          <span className="lbl">{node.label}</span>
          {node.presence === 'ghosted' && <span className="gtag">not observed here</span>}
        </div>
        {node.operands.length > 0 && (
          <div className="ops">
            {node.operands.map((o, i) => (
              <OperandChip key={i} o={o} />
            ))}
          </div>
        )}
        {node.question && <div className="qflag">? {node.question}</div>}
      </div>
    </div>
  )
}

export function DataflowGraph({ graph }: { graph: GraphModel }): React.JSX.Element {
  const t = graph.transparency
  const classifier =
    t.classifier_mode === 'vocab'
      ? `vocab · ${t.vocab_size} fields`
      : `non-vocab · ${t.fallback_reason ?? 'no models found'}`

  return (
    <div className="flow">
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
        <span className="li">
          <span className="sw observed" />
          observed — measured this run
        </span>
        <span className="li">
          <span className="sw declared" />
          declared — read from source
        </span>
        <span className="li">
          <span className="sw unknown" />
          you supply — a blank, not a fact
        </span>
        <span className="li">
          <span className="sw ghost" />
          not observed — coverage boundary
        </span>
      </div>

      <div className="spine">
        {graph.nodes.map((n) => (
          <Node key={n.id} node={n} />
        ))}
      </div>

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
