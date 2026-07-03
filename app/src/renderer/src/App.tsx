// grasp — the post-editor shell. Sidebar · conversation · the live dataflow instrument.
// You ask an agent to change code; as it works, the observed dataflow updates live on
// the right, ending in the question. Never a verdict.
import { useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Conversation, type TranscriptItem } from './components/Conversation'
import { DataflowGraph } from './components/DataflowGraph'
import { DataflowDiff } from './components/DataflowDiff'
import { FuzzView } from './components/FuzzView'
import { KeyGate } from './components/KeyGate'
import type { AgentEvent, FuzzReport, GraphDiffModel, GraphModel } from '../../shared/types'

type Surface =
  | { kind: 'flow'; graph: GraphModel }
  | { kind: 'diff'; diff: GraphDiffModel }
  | { kind: 'fuzz'; report: FuzzReport }
const MODEL = 'GLM-4.6'

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [surface, setSurface] = useState<Surface | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyReady, setKeyReady] = useState<boolean | null>(null)
  const [watchEp, setWatchEp] = useState('')
  const [watchInput, setWatchInput] = useState('')
  const history = useRef<unknown[]>([])

  useEffect(() => {
    void window.grasp.keyStatus().then(setKeyReady)
  }, [])

  useEffect(() => {
    return window.grasp.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'text') setTranscript((t) => [...t, { role: 'assistant', text: e.text }])
      else if (e.type === 'tool_use')
        setTranscript((t) => [...t, { id: e.id, role: 'tool', name: e.name, input: e.input, status: 'running' }])
      else if (e.type === 'tool_result')
        setTranscript((t) => t.map((it) => (it.id === e.id ? { ...it, summary: e.summary, status: 'done' } : it)))
      else if (e.type === 'dataflow') setSurface({ kind: 'flow', graph: e.graph })
      else if (e.type === 'dataflow_diff') setSurface({ kind: 'diff', diff: e.diff })
      else if (e.type === 'fuzz') setSurface({ kind: 'fuzz', report: e.report })
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
    const watch = watchEp.trim() ? { entrypoint: watchEp.trim(), input: watchInput.trim() || undefined } : undefined
    const res = await window.grasp.agent({ workspace, prompt, history: history.current, watch })
    history.current = res.messages
  }

  function newSession(): void {
    history.current = []
    setTranscript([])
    setSurface(null)
    setError(null)
  }

  return (
    <div className="app">
      {keyReady === false && <KeyGate onSaved={() => setKeyReady(true)} />}

      <Sidebar workspace={workspace} onWorkspace={setWorkspace} onNewSession={newSession} sessionTitle="Current session" />

      <Conversation transcript={transcript} busy={busy} error={error} model={MODEL} onSend={send} />

      <aside className="instrument">
        <div className="inst-head">
          <span className="lbl">
            {surface?.kind === 'diff' ? 'dataflow change' : surface?.kind === 'fuzz' ? 'fuzzed inputs' : 'observed dataflow'}
          </span>
          <span className="live">
            <span className="pulse" />
            live
          </span>
        </div>
        <div className="watch-field">
          <label>watch</label>
          <input
            className="we"
            value={watchEp}
            onChange={(e) => setWatchEp(e.target.value)}
            placeholder="module.func"
            spellCheck={false}
          />
          <input
            className="wi"
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value)}
            placeholder='{"name":"x"}'
            spellCheck={false}
          />
        </div>
        <div className="inst-body">
          {surface?.kind === 'diff' ? (
            <DataflowDiff diff={surface.diff} />
          ) : surface?.kind === 'fuzz' ? (
            <FuzzView report={surface.report} />
          ) : surface?.kind === 'flow' ? (
            <DataflowGraph graph={surface.graph} />
          ) : (
            <div className="inst-empty">
              Set an entrypoint to <b>watch</b>, then ask the agent to change code. After each edit grasp runs it
              for real and shows the dataflow change here — ending in a question, never a verdict.
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
