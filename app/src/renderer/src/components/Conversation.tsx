// The conversation: markdown-rendered agent messages, tool-call chips, a real composer
// with a working provider/model selector — grasp is agent-agnostic.
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BackendInfo } from '../../../shared/types'

export interface TranscriptItem {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'plan' | 'approval'
  text?: string
  name?: string
  input?: Record<string, unknown>
  summary?: string
  status?: 'running' | 'done'
}

function ToolIcon(): React.JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" fill="none">
      <path d="M8 6l-4 6 4 6M16 6l4 6-4 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Tool({ it }: { it: TranscriptItem }): React.JSX.Element {
  const arg =
    it.name === 'run_bash' || it.name === 'Bash'
      ? String(it.input?.command ?? '')
      : it.name === 'grasp_observe' || it.name === 'grasp_diff' || it.name === 'grasp_fuzz'
        ? String(it.input?.entrypoint ?? '')
        : String(it.input?.path ?? it.input?.file_path ?? '')
  return (
    <div className={`tool ${it.status ?? ''}`}>
      <ToolIcon />
      <span className="tn">{it.name}</span>
      <span className="ta">{arg}</span>
      {it.summary && <span className="ts">{it.summary}</span>}
    </div>
  )
}

// The provider/model selector — a chip that is actually a control.
function ModelPicker(props: {
  backends: BackendInfo[]
  backend: string
  model: string
  onBackend: (id: string) => void
  onModel: (m: string) => void
}): React.JSX.Element {
  const active = props.backends.find((b) => b.id === props.backend)
  return (
    <span className="picker">
      <span className={`g${active?.ok ? '' : ' off'}`} title={active?.ok ? 'available' : (active?.reason ?? 'unavailable')} />
      <select value={props.backend} onChange={(e) => props.onBackend(e.target.value)} title="agent backend">
        {props.backends.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
      <span className="sep">/</span>
      <select value={props.model} onChange={(e) => props.onModel(e.target.value)} title="model">
        {(active?.models ?? []).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </span>
  )
}

// A proposed plan awaiting the human: approve executes it, revise focuses the composer.
function PlanCard(props: { text: string; latest: boolean; busy: boolean; onApprove: (text: string) => void }): React.JSX.Element {
  return (
    <div className="plan-card">
      <div className="plan-head">
        <span className="eyebrow">proposed plan</span>
        <span className="plan-badge">awaiting your approval</span>
      </div>
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.text}</ReactMarkdown>
      </div>
      {props.latest && (
        <div className="plan-actions">
          <button className="btn primary" disabled={props.busy} onClick={() => props.onApprove(props.text)}>
            Approve &amp; execute
          </button>
          <span className="plan-hint">or reply below to revise the plan</span>
        </div>
      )}
    </div>
  )
}

// An Ask-mode approval: a mutating tool is paused until you allow or deny it.
function ApprovalCard(props: { it: TranscriptItem; onDecide: (id: string, ok: boolean) => void }): React.JSX.Element {
  const { it } = props
  const detail =
    it.name === 'run_bash' ? String(it.input?.command ?? '') : String(it.input?.path ?? '')
  const decided = it.status === 'done'
  return (
    <div className={`approval-card${decided ? ' decided' : ''}`}>
      <div className="approval-head">
        <span className="eyebrow q">approval needed</span>
        {decided && <span className={`approval-verdict ${it.summary}`}>{it.summary}</span>}
      </div>
      <div className="approval-body">
        <span className="tn">{it.name}</span>
        <span className="approval-detail">{detail}</span>
      </div>
      {!decided && (
        <div className="approval-actions">
          <button className="btn primary" onClick={() => props.onDecide(it.id!, true)}>
            Allow
          </button>
          <button className="btn" onClick={() => props.onDecide(it.id!, false)}>
            Deny
          </button>
        </div>
      )}
    </div>
  )
}

export function Conversation(props: {
  transcript: TranscriptItem[]
  busy: boolean
  error: string | null
  backends: BackendInfo[]
  backend: string
  model: string
  mode: 'auto' | 'ask' | 'plan'
  onBackend: (id: string) => void
  onModel: (m: string) => void
  onMode: (m: 'auto' | 'ask' | 'plan') => void
  onApprovePlan: (text: string) => void
  onDecideApproval: (id: string, ok: boolean) => void
  onSend: (prompt: string) => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [props.transcript, props.busy])

  function submit(): void {
    const t = input.trim()
    if (!t || props.busy) return
    props.onSend(t)
    setInput('')
  }

  const activeLabel = props.backends.find((b) => b.id === props.backend)?.label ?? props.backend

  return (
    <section className="conv">
      <header className="conv-head">
        <span className="conv-title">
          Session<span className="sub">post-editor</span>
        </span>
        <span className="chip">
          <span className="g" />
          {activeLabel} · {props.model}
        </span>
      </header>

      <div className="conv-log" ref={logRef}>
        {props.transcript.length === 0 && (
          <div className="conv-empty">
            <h2>What should we change?</h2>
            <p>
              Ask an agent to edit code in your workspace. As it works, the observed dataflow updates live on the
              right — you adjudicate what the change did, never a &ldquo;does it work&rdquo;.
            </p>
          </div>
        )}
        {props.transcript.map((it, i) =>
          it.role === 'plan' ? (
            <PlanCard
              key={i}
              text={it.text ?? ''}
              latest={i === props.transcript.length - 1}
              busy={props.busy}
              onApprove={props.onApprovePlan}
            />
          ) : it.role === 'approval' ? (
            <ApprovalCard key={it.id ?? i} it={it} onDecide={props.onDecideApproval} />
          ) : it.role === 'tool' ? (
            <Tool key={it.id ?? i} it={it} />
          ) : it.role === 'user' ? (
            <div key={i} className="msg user">
              <div className="who">you</div>
              <div className="bubble">{it.text}</div>
            </div>
          ) : (
            <div key={i} className="msg assistant">
              <div className="prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text ?? ''}</ReactMarkdown>
              </div>
            </div>
          )
        )}
        {props.busy && (
          <div className="msg assistant">
            <div className="prose" style={{ color: 'var(--muted)' }}>
              working…
            </div>
          </div>
        )}
        {props.error && <div className="msg-error">{props.error}</div>}
      </div>

      <div className="composer">
        <div className="box">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Ask an agent to change code…"
            rows={2}
            autoFocus
          />
          <div className="row">
            <ModelPicker
              backends={props.backends}
              backend={props.backend}
              model={props.model}
              onBackend={props.onBackend}
              onModel={props.onModel}
            />
            <span
              className="mode-toggle"
              title="Build: edit directly. Ask: approve each edit. Plan: propose first — nothing changes until you approve."
            >
              <button className={props.mode === 'auto' ? 'on' : ''} onClick={() => props.onMode('auto')}>
                Build
              </button>
              <button className={props.mode === 'ask' ? 'on' : ''} onClick={() => props.onMode('ask')}>
                Ask
              </button>
              <button className={props.mode === 'plan' ? 'on' : ''} onClick={() => props.onMode('plan')}>
                Plan
              </button>
            </span>
            <button className="send" onClick={submit} disabled={props.busy} title="Send (Cmd/Ctrl+Enter)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
