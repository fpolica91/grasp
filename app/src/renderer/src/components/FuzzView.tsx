// The fuzz surface — the new stack trace. Which operands BENT across inputs, which
// inputs RAISED, the gaps. No verdict; the facts end in neutral questions.
// Migrated to Tailwind v4.
import type { FuzzReport, FuzzVaried, FuzzRaise } from '../../../shared/types'

function repro(input: Record<string, unknown>): string {
  try { return JSON.stringify(input) } catch { return String(input) }
}

const CAP = 8

function Varied({ v }: { v: FuzzVaried }): React.JSX.Element {
  const shown = v.values.slice(0, CAP)
  const more = v.values.length - shown.length
  return (
    <div className="rounded-lg border border-border bg-panel p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[0.625rem] uppercase font-medium text-foreground-subtlest">{v.kind}</span>
        <span className="text-[0.8125rem] font-medium text-foreground">{v.label}.{v.operand}</span>
        <span className="rounded px-1.5 text-[0.625rem] uppercase bg-tag text-foreground">{v.values.length} values</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {shown.map((val, i) => (
          <div key={i} className="flex items-center gap-2 font-mono text-[0.75rem]">
            <span className="rounded bg-foreground/5 px-1.5 py-0.5 text-foreground">{typeof val.value === 'string' ? `'${val.value}'` : String(val.value)}</span>
            <span className="text-foreground-subtlest">← {repro(val.reproduce_with)}</span>
          </div>
        ))}
        {more > 0 && <div className="text-[0.6875rem] text-foreground-subtlest">+{more} more</div>}
      </div>
      <div className="mt-1 text-[0.8125rem] text-foreground-subtle">? {v.operand} takes {v.values.length} value{v.values.length === 1 ? '' : 's'} — intended?</div>
    </div>
  )
}

function Raise({ r }: { r: FuzzRaise }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[0.625rem] uppercase font-medium text-destructive">raised</span>
        <span className="text-[0.8125rem] font-medium text-foreground">{r.type}</span>
        <span className="rounded bg-destructive/10 px-1.5 text-[0.625rem] uppercase text-destructive">input</span>
      </div>
      {r.message && <div className="font-mono text-[0.75rem] text-destructive">{r.message}</div>}
      <div className="font-mono text-[0.75rem] text-foreground-subtlest">← {repro(r.reproduce_with)}</div>
    </div>
  )
}

export function FuzzView({ report }: { report: FuzzReport }): React.JSX.Element {
  const nGaps = report.errors.length
  const varied = [...report.varied].sort((a, b) => a.values.length - b.values.length)
  const questions = varied.map((v) => `${v.operand} takes ${v.values.length} value${v.values.length === 1 ? '' : 's'} — intended?`).concat(report.raises.map((r) => `input ${repro(r.reproduce_with)} raises ${r.type} — intended?`))
  const clean = report.varied.length === 0 && report.raises.length === 0

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">fuzzed · {report.ran}/{report.variant_count} inputs</div>
      <h1 className="font-mono text-[1rem] font-semibold text-foreground">{report.entrypoint}</h1>
      <div className="flex flex-wrap gap-3 text-[0.75rem] text-foreground-subtle">
        <span>egress <b className="text-foreground">{report.egress}</b></span>
        <span>containment <b className="text-foreground">{report.containment_level}</b></span>
        {nGaps > 0 && <span>unobserved <b className="text-foreground">{nGaps}</b></span>}
      </div>
      <div className="flex flex-col gap-2">
        {varied.map((v, i) => <Varied key={`v${i}`} v={v} />)}
        {report.raises.map((r, i) => <Raise key={`r${i}`} r={r} />)}
        {clean && <div className="py-4 text-[0.8125rem] text-foreground-subtlest">Nothing varied or raised across {report.ran} inputs. That is not a pass — it is what these seeded inputs exercised{nGaps ? `; ${nGaps} could not be observed.` : '.'}</div>}
      </div>
      {!clean && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">you adjudicate</div>
          <h2 className="mt-1 text-[0.875rem] font-semibold text-foreground">Some inputs bend the behavior.</h2>
          <ul className="mt-1 flex flex-col gap-1">{questions.map((q, i) => (<li key={i} className="flex gap-2 text-[0.8125rem] text-foreground-subtle"><span className="text-foreground-subtlest">?</span><span>{q}</span></li>))}</ul>
        </div>
      )}
      <div className="mt-auto pt-3 text-[0.75rem] leading-relaxed text-foreground-subtlest">Each value and raise above is measured from a real run of a seeded input; the reproducing input is exact.</div>
    </div>
  )
}
