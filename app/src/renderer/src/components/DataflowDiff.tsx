// The A->B change view as native React: what the agent's edit did to the behavior.
// Color is TEMPORAL (before = muted, after = signal), never good/bad. Status (added/
// removed/changed) is a fact; the flow terminates in a neutral question. No verdict.
import type { DiffNode, GraphDiffModel, OperandDelta, Operand } from '../../../shared/types'

function Delta({ d }: { d: OperandDelta }): React.JSX.Element {
  return (
    <div className="delta">
      <span className="dk">{d.field}</span>
      <span className="old">{d.old}</span>
      <span className="arrow">→</span>
      <span className="new">{d.new}</span>
      <span className="prov">[{d.provenance}]</span>
    </div>
  )
}

function Chip({ o }: { o: Operand }): React.JSX.Element {
  return (
    <span className={`op op-${o.provenance}`}>
      <span className="op-k">{o.name}</span>
      <span className="op-v">{o.display}</span>
    </span>
  )
}

function Node({ node }: { node: DiffNode }): React.JSX.Element {
  const cls = ['node', node.status]
  if (node.presence === 'ghosted') cls.push('ghosted')
  return (
    <div className={cls.join(' ')}>
      <div className="card">
        <div className="chead">
          <span className="kind">{node.kind}</span>
          <span className="lbl">{node.label}</span>
          <span className={`stag ${node.status}`}>{node.status}</span>
        </div>
        {node.deltas.length > 0 ? (
          <div className="deltas">
            {node.deltas.map((d, i) => (
              <Delta key={i} d={d} />
            ))}
          </div>
        ) : node.operands.length > 0 ? (
          <div className="ops">
            {node.operands.map((o, i) => (
              <Chip key={i} o={o} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function DataflowDiff({ diff }: { diff: GraphDiffModel }): React.JSX.Element {
  return (
    <div className="flow">
      <div className="eyebrow">dataflow change</div>
      <h1 className="fentry">{diff.entrypoint}</h1>
      <div className="readout">
        <span>
          old <b>{String(diff.old_ref)}</b>
        </span>
        <span>
          new <b>{String(diff.new_ref)}</b>
        </span>
        <span>
          changes <b>{diff.changed_count}</b>
        </span>
      </div>

      <div className="legend">
        <span className="li">
          <span className="sw observed" />
          after — new behavior
        </span>
        <span className="li">
          <span className="sw declared" />
          before — old behavior
        </span>
        <span className="li">
          <span className="sw ghost" />
          removed — no longer runs
        </span>
      </div>

      {diff.empty ? (
        <div className="qpanel">
          <div className="eyebrow q">you adjudicate</div>
          <p className="empty">{diff.honest_message}</p>
        </div>
      ) : (
        <>
          <div className="spine">
            {diff.nodes.map((n) => (
              <Node key={n.id} node={n} />
            ))}
          </div>
          <div className="qpanel">
            <div className="eyebrow q">you adjudicate</div>
            <h2>The dataflow changed. Is this what you expected?</h2>
            <ul className="qlist">
              {diff.questions.map((q, i) => (
                <li key={i}>
                  <span className="mark">?</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="foot">
        Old and new were each run for real under the same input; the deltas are measured, not inferred. grasp does not
        label the change correct or incorrect. That is yours to say.
      </div>
    </div>
  )
}
