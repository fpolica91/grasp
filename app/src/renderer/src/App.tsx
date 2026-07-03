// grasp — the post-editor shell. Left: the agent (a real tool-use loop on GLM). Right:
// the observed dataflow. The agent edits code and calls grasp_observe; the dataflow it
// surfaces lands in the right pane. You adjudicate behavior, not diffs.
import { useEffect, useRef, useState } from 'react'
import { Chat, type TranscriptItem } from './components/Chat'
import { DataflowGraph } from './components/DataflowGraph'
import { DataflowDiff } from './components/DataflowDiff'
import { KeyGate } from './components/KeyGate'
import type { AgentEvent, GraphDiffModel, GraphModel } from '../../shared/types'

type Surface = { kind: 'flow'; graph: GraphModel } | { kind: 'diff'; diff: GraphDiffModel }

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [surface, setSurface] = useState<Surface | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyReady, setKeyReady] = useState<boolean | null>(null)
  const history = useRef<unknown[]>([])

  useEffect(() => {
    void window.grasp.keyStatus().then(setKeyReady)
  }, [])

  // subscribe once to the agent event stream
  useEffect(() => {
    return window.grasp.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'text') setTranscript((t) => [...t, { role: 'assistant', text: e.text }])
      else if (e.type === 'tool_use')
        setTranscript((t) => [...t, { id: e.id, role: 'tool', name: e.name, input: e.input, status: 'running' }])
      else if (e.type === 'tool_result')
        setTranscript((t) => t.map((it) => (it.id === e.id ? { ...it, summary: e.summary, status: 'done' } : it)))
      else if (e.type === 'dataflow') setSurface({ kind: 'flow', graph: e.graph })
      else if (e.type === 'dataflow_diff') setSurface({ kind: 'diff', diff: e.diff })
      else if (e.type === 'done') setBusy(false)
      else if (e.type === 'error') {
        setError(e.error)
        setBusy(false)
      }
    })
  }, [])

  async function send(prompt: string): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    setTranscript((t) => [...t, { role: 'user', text: prompt }])
    const res = await window.grasp.agent({ workspace, prompt, history: history.current })
    history.current = res.messages
  }

  return (
    <div className="app">
      {keyReady === false && <KeyGate onSaved={() => setKeyReady(true)} />}
      <header className="topbar">
        <span className="brand">grasp</span>
        <span className="tag">the post-editor · adjudicate behavior, not diffs</span>
        <input
          className="i-ws"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="workspace path"
          title="the folder the agent works in"
        />
      </header>

      <div className="split">
        <section className="pane chat-pane">
          <Chat transcript={transcript} busy={busy} error={error} onSend={send} />
        </section>

        <section className="pane flow-pane">
          <div className="flow-body">
            {surface?.kind === 'diff' ? (
              <DataflowDiff diff={surface.diff} />
            ) : surface?.kind === 'flow' ? (
              <DataflowGraph graph={surface.graph} />
            ) : (
              <div className="flow-placeholder">
                The observed dataflow appears here. Ask the agent to change code — after it edits, it runs the
                entrypoint for real and surfaces what the change did to the behavior (A→B), ending in a question.
                grasp never renders a verdict.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
