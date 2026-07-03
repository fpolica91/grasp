// The agent transcript + composer (presentational). Renders the streaming tool-use
// loop: assistant text, tool calls (read/write/run/grasp_observe), and their results.
import { useEffect, useRef, useState } from 'react'

export interface TranscriptItem {
  id?: string
  role: 'user' | 'assistant' | 'tool'
  text?: string
  name?: string
  input?: Record<string, unknown>
  summary?: string
  status?: 'running' | 'done'
}

function ToolItem({ it }: { it: TranscriptItem }): React.JSX.Element {
  const arg =
    it.name === 'run_bash'
      ? String(it.input?.command ?? '')
      : it.name === 'grasp_observe'
        ? String(it.input?.entrypoint ?? '')
        : String(it.input?.path ?? '')
  return (
    <div className={`tool ${it.status ?? ''}`}>
      <span className="tname">{it.name}</span>
      <span className="targ">{arg}</span>
      {it.summary && <span className="tsum">{it.summary}</span>}
    </div>
  )
}

export function Chat(props: {
  transcript: TranscriptItem[]
  busy: boolean
  error: string | null
  onSend: (prompt: string) => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [props.transcript, props.busy])

  function submit(): void {
    const text = input.trim()
    if (!text || props.busy) return
    props.onSend(text)
    setInput('')
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {props.transcript.length === 0 && (
          <div className="chat-empty">
            Ask grasp to change some code. It edits with real tools, then shows you what the change does to the data —
            not that it &ldquo;works&rdquo;.
          </div>
        )}
        {props.transcript.map((it, i) =>
          it.role === 'tool' ? (
            <ToolItem key={it.id ?? i} it={it} />
          ) : (
            <div key={i} className={`msg ${it.role}`}>
              <div className="role">{it.role === 'user' ? 'you' : 'grasp'}</div>
              <div className="content">{it.text}</div>
            </div>
          )
        )}
        {props.busy && <div className="msg assistant"><div className="role">grasp</div><div className="content dim">…working</div></div>}
        {props.error && <div className="chat-error">{props.error}</div>}
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask grasp to change code…  (Cmd/Ctrl+Enter)"
          rows={3}
          autoFocus
        />
        <button onClick={submit} disabled={props.busy}>
          Send
        </button>
      </div>
    </div>
  )
}
