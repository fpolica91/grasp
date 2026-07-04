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
  parent?: string // set on subagent activity: the id of the parent `task` tool call
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
        : it.name === 'task' || it.name === 'Task'
          ? String(it.input?.description ?? it.input?.prompt ?? '')
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
  tokens: number
  budget: string
  onBudget: (v: string) => void
  onBackend: (id: string) => void
  onModel: (m: string) => void
  onMode: (m: 'auto' | 'ask' | 'plan') => void
  onApprovePlan: (text: string) => void
  onDecideApproval: (id: string, ok: boolean) => void
  onSend: (prompt: string) => void
}): React.JSX.Element {
  const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
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

  const top = props.transcript.filter((it) => !it.parent)

  // Render one transcript item by role. Subagent children reuse the same renderer.
  const renderItem = (it: TranscriptItem, i: number, isLast = false): React.JSX.Element => {
    if (it.role === 'plan')
      return (
        <PlanCard key={i} text={it.text ?? ''} latest={isLast} busy={props.busy} onApprove={props.onApprovePlan} />
      )
    if (it.role === 'approval') return <ApprovalCard key={it.id ?? i} it={it} onDecide={props.onDecideApproval} />
    if (it.role === 'tool') {
      const kids = it.id ? props.transcript.filter((k) => k.parent === it.id) : []
      const chip = <Tool key={it.id ?? i} it={it} />
      if (it.name === 'task' && kids.length > 0)
        return (
          <div key={it.id ?? i} className="subagent">
            {chip}
            <div className="subagent-body">{kids.map((k, ki) => renderItem(k, ki))}</div>
          </div>
        )
      return chip
    }
    if (it.role === 'user')
      return (
        <div key={i} className="msg user">
          <div className="who">you</div>
          <div className="bubble">{it.text}</div>
        </div>
      )
    return (
      <div key={i} className="msg assistant">
        <div className="prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text ?? ''}</ReactMarkdown>
        </div>
      </div>
    )
  }

  return (
    <section className="conv">
      <header className="conv-head">
        <span className="conv-title">
          Session<span className="sub">post-editor</span>
        </span>
        <span className="meter" title="tokens used this session · optional per-turn budget">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".4" />
            <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {fmtTokens(props.tokens)}
          <span className="meter-sep">budget</span>
          <input
            className="budget"
            value={props.budget}
            onChange={(e) => props.onBudget(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="none"
            spellCheck={false}
          />
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
        {/* top-level items only; subagent children render nested under their task */}
        {top.map((it, i) => renderItem(it, i, i === top.length - 1))}
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
