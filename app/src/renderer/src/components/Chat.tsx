// The agent chat. Talks to the model (GLM by default) via the main process. This is
// the agent half; the post-editor loop is: agent writes → grasp observes → you adjudicate.
import { useState } from 'react'
import type { ChatMessage } from '../../../shared/types'

export function Chat(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    setError(null)
    const res = await window.grasp.chat(next)
    setBusy(false)
    if (res.ok) setMessages([...next, { role: 'assistant', content: res.text }])
    else setError(res.error ?? 'model error')
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {messages.length === 0 && <div className="chat-empty">Ask grasp anything. It writes code; grasp shows what the change does.</div>}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="content">{m.content}</div>
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="role">grasp</div><div className="content dim">…thinking</div></div>}
        {error && <div className="chat-error">{error}</div>}
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Ask grasp…  (Cmd/Ctrl+Enter to send)"
          rows={3}
        />
        <button onClick={() => void send()} disabled={busy}>
          Send
        </button>
      </div>
    </div>
  )
}
