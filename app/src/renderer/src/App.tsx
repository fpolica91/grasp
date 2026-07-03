// grasp — the post-editor shell. Left: the agent (chat). Right: the observed dataflow
// (the differentiator). This is a real, owned React app — the beginning of the product.
import { useState } from 'react'
import { Chat } from './components/Chat'
import { DataflowGraph } from './components/DataflowGraph'
import type { GraphModel } from '../../shared/types'

export function App(): React.JSX.Element {
  const [repo, setRepo] = useState('.')
  const [entrypoint, setEntrypoint] = useState('')
  const [input, setInput] = useState('')
  const [graph, setGraph] = useState<GraphModel | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function observe(): Promise<void> {
    if (!entrypoint.trim() || busy) return
    setBusy(true)
    setStatus('running the entrypoint for real…')
    const res = await window.grasp.observe({ repo, entrypoint, input })
    setBusy(false)
    if (res.observed && res.graph) {
      setGraph(res.graph)
      setStatus(null)
    } else {
      setGraph(null)
      setStatus(res.error ?? 'could not observe')
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">grasp</span>
        <span className="tag">the post-editor · adjudicate behavior, not diffs</span>
      </header>

      <div className="split">
        <section className="pane chat-pane">
          <Chat />
        </section>

        <section className="pane flow-pane">
          <div className="flow-bar">
            <input className="i-repo" value={repo} onChange={(e) => setRepo(e.target.value)} title="repo" />
            <input
              className="i-ep"
              value={entrypoint}
              onChange={(e) => setEntrypoint(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void observe()}
              placeholder="module.func"
              autoFocus
            />
            <input
              className="i-in"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void observe()}
              placeholder='{"name":"x"}'
            />
            <button onClick={() => void observe()} disabled={busy}>
              Observe
            </button>
          </div>
          <div className="flow-body">
            {graph ? (
              <DataflowGraph graph={graph} />
            ) : (
              <div className="flow-placeholder">
                {status ?? 'Point at an entrypoint and press Observe — grasp runs it for real and shows the observed dataflow, ending in a question. It never renders a verdict.'}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
