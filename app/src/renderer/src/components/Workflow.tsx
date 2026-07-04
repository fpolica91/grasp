// Durable workflows — define an ordered list of steps once, run them one at a time.
// Progress persists, so a workflow interrupted by a restart resumes from its
// unfinished step. The panel shows live step status; the modal defines a new one.
import { useState } from 'react'
import type { WorkflowRecord } from '../../../shared/types'

export function WorkflowModal(props: {
  onCreate: (title: string, steps: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const steps = body.split('\n').map((s) => s.trim()).filter(Boolean)
  return (
    <div className="gate-overlay" onClick={props.onClose}>
      <div className="gate wf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">new workflow</div>
        <h2>Define the steps</h2>
        <p>Each line is one step. grasp runs them in order against the same conversation — investigate, edit, observe, verify — and remembers its place if you restart.</p>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Workflow name" spellCheck={false} />
        <textarea
          className="wf-steps"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'Read app.py and find where owner is set\nSet owner to the given name\nObserve app.create and summarize the change'}
          rows={6}
          spellCheck={false}
        />
        <div className="wf-modal-foot">
          <span className="plan-hint">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={steps.length === 0} onClick={() => props.onCreate(title.trim() || 'Workflow', steps)}>
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
  onDismiss: () => void
}): React.JSX.Element {
  const { wf } = props
  const done = wf.steps.filter((s) => s.status === 'done').length
  const interrupted = wf.status === 'running' && !props.busy // persisted running but not live = resumable
  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        <span className="eyebrow">workflow</span>
        <span className="wf-title">{wf.title}</span>
        <span className="wf-progress">
          {done}/{wf.steps.length}
        </span>
        {wf.status === 'done' && <span className="wf-badge done">done</span>}
        {interrupted && (
          <button className="btn primary wf-resume" onClick={props.onResume}>
            Resume
          </button>
        )}
        <button className="wf-x" onClick={props.onDismiss} title="dismiss">
          ✕
        </button>
      </div>
      <ol className="wf-steps-list">
        {wf.steps.map((s, i) => (
          <li key={i} className={`wf-step ${s.status}`}>
            <span className="wf-dot" />
            <span className="wf-step-text">{s.prompt}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
