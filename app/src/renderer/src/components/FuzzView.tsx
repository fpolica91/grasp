// The fuzz surface — the new stack trace. Across many inputs: which operands BENT,
// which inputs RAISED, and the gaps — each with a reproducing input. No verdict; the
// varied/raising facts end in neutral questions the human adjudicates.
import type { FuzzReport, FuzzVaried, FuzzRaise, FuzzErrorVariant } from '../../../shared/types'

function repro(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

const CAP = 8

function Varied({ v }: { v: FuzzVaried }): React.JSX.Element {
  const shown = v.values.slice(0, CAP)
  const more = v.values.length - shown.length
  return (
    <div className="node business">
      <div className="card">
        <div className="chead">
          <span className="kind">{v.kind}</span>
          <span className="lbl">{v.label}.{v.operand}</span>
          <span className="stag changed">{v.values.length} values</span>
        </div>
        <div className="fuzz-vals">
          {shown.map((val, i) => (
            <div key={i} className="fuzz-val">
              <span className="fv">{typeof val.value === 'string' ? `'${val.value}'` : String(val.value)}</span>
              <span className="fr">← {repro(val.reproduce_with)}</span>
            </div>
          ))}
          {more > 0 && <div className="fuzz-more">+{more} more input{more === 1 ? '' : 's'}</div>}
        </div>
        <div className="qflag">? {v.operand} takes {v.values.length} value{v.values.length === 1 ? '' : 's'} across inputs — intended?</div>
      </div>
    </div>
  )
}

function Raise({ r }: { r: FuzzRaise }): React.JSX.Element {
  return (
    <div className="node removed">
      <div className="card">
        <div className="chead">
          <span className="kind">raised</span>
          <span className="lbl">{r.type}</span>
          <span className="stag removed">input</span>
        </div>
        {r.message && <div className="fuzz-msg">{r.message}</div>}
        <div className="fuzz-val">
          <span className="fr">← {repro(r.reproduce_with)}</span>
        </div>
      </div>
    </div>
  )
}

export function FuzzView({ report }: { report: FuzzReport }): React.JSX.Element {
  const nGaps = report.errors.length
  // low-cardinality operands first: a value that takes 2–3 values (a threshold/branch)
  // is more adjudicable than one that just echoes a 32-value input.
  const varied = [...report.varied].sort((a, b) => a.values.length - b.values.length)
  const questions = varied
    .map((v) => `${v.operand} takes ${v.values.length} value${v.values.length === 1 ? '' : 's'} across inputs — intended?`)
    .concat(report.raises.map((r) => `input ${repro(r.reproduce_with)} raises ${r.type} — intended?`))
  const clean = report.varied.length === 0 && report.raises.length === 0

  return (
    <div className="flow">
      <div className="eyebrow">fuzzed · {report.ran}/{report.variant_count} inputs</div>
      <h1 className="fentry">{report.entrypoint}</h1>
      <div className="readout">
        <span>
          egress <b>{report.egress}</b>
        </span>
        <span>
          containment <b>{report.containment_level}</b>
        </span>
        {nGaps > 0 && (
          <span>
            unobserved <b>{nGaps}</b>
          </span>
        )}
      </div>

      <div className="spine">
        {varied.map((v, i) => (
          <Varied key={`v${i}`} v={v} />
        ))}
        {report.raises.map((r, i) => (
          <Raise key={`r${i}`} r={r} />
        ))}
        {clean && (
          <div className="inst-empty" style={{ padding: '18px 4px' }}>
            Nothing varied or raised across {report.ran} inputs. That is not a pass — it is what these seeded
            inputs exercised{nGaps ? `; ${nGaps} variant(s) could not be observed (gaps, not evidence).` : '.'}
          </div>
        )}
      </div>

      {!clean && (
        <div className="qpanel">
          <div className="eyebrow q">you adjudicate</div>
          <h2>Some inputs bend the behavior.</h2>
          <ul className="qlist">
            {questions.map((q, i) => (
              <li key={i}>
                <span className="mark">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="foot">
        Each value and raise above is measured from a real run of a seeded input; the reproducing input is exact.
        grasp shows which inputs bend the behavior — whether that is intended is yours to say.
      </div>
    </div>
  )
}
