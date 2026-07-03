// The conversation: markdown-rendered agent messages, tool-call chips, a real composer
// with a working provider/model selector — grasp is agent-agnostic.
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BackendInfo } from '../../../shared/types'

export interface TranscriptItem {
  id?: string
  role: 'user' | 'assistant' | 'tool'
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

export function Conversation(props: {
  transcript: TranscriptItem[]
  busy: boolean
  error: string | null
  backends: BackendInfo[]
  backend: string
  model: string
  onBackend: (id: string) => void
  onModel: (m: string) => void
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
          it.role === 'tool' ? (
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
            <button className="send" onClick={submit} disabled={props.busy} title="Send (Cmd/Ctrl+Enter)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
