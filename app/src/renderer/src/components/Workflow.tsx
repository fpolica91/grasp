// Durable workflows — define an ordered list of steps once, run them one at a time.
// Progress persists, so a workflow interrupted by a restart resumes from its
// unfinished step. The panel shows live step status; the modal defines a new one.
// Migrated to Tailwind v4 utilities matching ZCode's aesthetic.
import { useState } from 'react'
import type { WorkflowRecord } from '../../../shared/types'

export function WorkflowModal(props: {
  onCreate: (title: string, steps: string[], budget?: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [budgetStr, setBudgetStr] = useState('')
  const steps = body.split('\n').map((s) => s.trim()).filter(Boolean)
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-[3px]" onClick={props.onClose}>
      <div
        className="flex w-[520px] max-w-[90vw] flex-col gap-4 rounded-2xl border border-border bg-card p-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[11px] font-medium uppercase tracking-wide text-foreground-subtlest">new workflow</div>
        <h2 className="text-[18px] font-semibold tracking-tight text-foreground">Define the steps</h2>
        <p className="text-[13px] leading-relaxed text-foreground-subtle">
          Each line is one step. grasp runs them in order against the same conversation — investigate, edit, observe, verify — and remembers its place if you restart.
        </p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Workflow name"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-input px-3.5 py-2.5 text-[14px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'Read app.py and find where owner is set\nSet owner to the given name\nObserve app.create and summarize the change'}
          rows={6}
          spellCheck={false}
          className="w-full resize-none rounded-lg border border-border bg-input px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover"
        />
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-foreground-subtlest">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          <input
            value={budgetStr}
            onChange={(e) => setBudgetStr(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="token budget / step (optional)"
            spellCheck={false}
            className="w-[220px] rounded-lg border border-border bg-input px-3 py-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover"
          />
          <button
            className="ml-auto rounded-lg border border-border bg-secondary px-3.5 py-2 text-[13px] font-medium text-foreground transition-filter hover:brightness-110"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110 disabled:opacity-50"
            disabled={steps.length === 0}
            onClick={() => {
              const b = parseInt(budgetStr, 10)
              props.onCreate(title.trim() || 'Workflow', steps, Number.isFinite(b) && b > 0 ? b : undefined)
            }}
          >
            Create &amp; run
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorkflowPanel(props: {
  wf: WorkflowRecord
  busy: boolean
  onResume: () => void
  onCancel: () => void
  onRetry: (stepIndex: number) => void
  onDismiss: () => void
}): React.JSX.Element {
  const { wf } = props
  const done = wf.steps.filter((s) => s.status === 'done').length
  const interrupted = wf.status === 'running' && !props.busy
  const live = props.busy && wf.status === 'running'
  return (
    <div className="flex flex-col gap-2 border-b border-border px-5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtlest">workflow</span>
        <span className="text-[13px] font-semibold text-foreground">{wf.title}</span>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground-subtlest">
          {done}/{wf.steps.length}
        </span>
        {wf.status === 'done' && (
          <span className="rounded-full border border-border bg-tag px-2 py-0.5 text-[10px] font-medium text-foreground">done</span>
        )}
        {wf.status === 'paused' && (
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground-subtlest">paused</span>
        )}
        {live && (
          <button
            className="ml-auto rounded-lg border border-border bg-secondary px-3 py-1.5 text-[12px] font-medium text-foreground transition-filter hover:brightness-110"
            onClick={props.onCancel}
            title="Stop after the current step"
          >
            Cancel
          </button>
        )}
        {interrupted && (
          <button
            className="ml-auto rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110"
            onClick={props.onResume}
          >
            Resume
          </button>
        )}
        <button
          className="ml-auto border-0 bg-transparent text-[14px] text-foreground-subtlest transition-colors hover:text-foreground"
          onClick={props.onDismiss}
          title="dismiss"
        >
          ✕
        </button>
      </div>
      <ol className="flex flex-col gap-1">
        {wf.steps.map((s, i) => (
          <li
            key={i}
            className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] ${
              s.status === 'done'
                ? 'text-foreground-subtlest'
                : s.status === 'running'
                ? 'text-foreground'
                : s.status === 'error'
                ? 'text-destructive'
                : 'text-foreground-subtlest'
            }`}
          >
            <span
              className={`size-2 shrink-0 rounded-full ${
                s.status === 'done'
                  ? 'bg-foreground-subtlest'
                  : s.status === 'running'
                  ? 'bg-primary'
                  : s.status === 'error'
                  ? 'bg-destructive'
                  : 'bg-tag'
              }`}
            />
            <span className="flex-1 truncate">{s.prompt}</span>
            {s.status !== 'running' && !live && (
              <button
                className="shrink-0 rounded-full border border-border bg-transparent px-2 py-0.5 text-[10px] text-foreground-subtlest transition-colors hover:border-border-hover hover:text-foreground"
                onClick={() => props.onRetry(i)}
                title="Re-run from this step (keeps prior history)"
              >
                ↻ retry
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
