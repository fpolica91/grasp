// grasp — the post-editor shell. Sidebar · conversation · the live dataflow instrument.
// You ask an agent to change code; as it works, the observed dataflow updates live on
// the right, ending in the question. Never a verdict.
import { useEffect, useRef, useState } from 'react'
import { Sidebar, type Theme } from './components/Sidebar'
import { Conversation, type TranscriptItem } from './components/Conversation'
import { DataflowGraph } from './components/DataflowGraph'
import { DataflowDiff } from './components/DataflowDiff'
import { FuzzView } from './components/FuzzView'
import { KeyGate } from './components/KeyGate'
import { WorkflowModal, WorkflowPanel } from './components/Workflow'
import type { AgentEvent, BackendInfo, FuzzReport, GraphDiffModel, GraphModel, SessionRecord, WorkflowRecord } from '../../shared/types'

type Surface =
  | { kind: 'flow'; graph: GraphModel }
  | { kind: 'diff'; diff: GraphDiffModel }
  | { kind: 'fuzz'; report: FuzzReport }

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [surface, setSurface] = useState<Surface | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyReady, setKeyReady] = useState<boolean | null>(null)
  const [watchEp, setWatchEp] = useState('')
  const [watchInput, setWatchInput] = useState('')
  const [varying, setVarying] = useState(false)
  const [fuzzReal, setFuzzReal] = useState(false) // false = walled (network denied)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('grasp-theme') as Theme) || 'graphite')
  const [backends, setBackends] = useState<BackendInfo[]>([])
  const [backend, setBackend] = useState('glm')
  const [model, setModel] = useState('')
  const [agentMode, setAgentMode] = useState<'auto' | 'ask' | 'plan'>('auto')
  const [tokens, setTokens] = useState(0)
  const [budget, setBudget] = useState('')

  // Resolve an Ask-mode approval and mark it decided in the transcript.
  function decideApproval(id: string, ok: boolean): void {
    void window.grasp.approve(id, ok)
    setTranscript((t) => t.map((it) => (it.id === id ? { ...it, status: 'done', summary: ok ? 'allowed' : 'denied' } : it)))
  }
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID())
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([])
  const [activeWf, setActiveWf] = useState<WorkflowRecord | null>(null)
  const [showWfModal, setShowWfModal] = useState(false)
  const history = useRef<unknown[]>([])

  // Load persisted workflows; surface the most recent unfinished one so it can resume.
  useEffect(() => {
    void window.grasp.workflows().then((ws) => {
      setWorkflows(ws)
      const interrupted = ws.find((w) => w.status === 'running' || w.status === 'paused')
      if (interrupted) setActiveWf(interrupted)
    })
  }, [])

  // The durable runner: run each pending step as an agent turn against the carried
  // history, persisting after every state change so a restart resumes from here.
  async function runWorkflow(base: WorkflowRecord): Promise<void> {
    if (busy) return
    const w: WorkflowRecord = { ...base, status: 'running' }
    for (let i = w.currentStep; i < w.steps.length; i++) {
      w.currentStep = i
      w.steps = w.steps.map((s, idx) => (idx === i ? { ...s, status: 'running' } : s))
      w.updatedAt = Date.now()
      await window.grasp.saveWorkflow(w)
      setActiveWf({ ...w })
      setTranscript((t) => [...t, { role: 'assistant', text: `**Step ${i + 1}/${w.steps.length}** · ${w.steps[i].prompt}` }])
      setBusy(true)
      setError(null)
      const res = await window.grasp.agent({
        workspace: w.workspace,
        prompt: w.steps[i].prompt,
        history: w.history,
        backend: w.backend,
        model: w.model
      })
      setBusy(false)
      w.history = res.messages
      w.steps = w.steps.map((s, idx) => (idx === i ? { ...s, status: 'done' } : s))
      w.currentStep = i + 1
      w.updatedAt = Date.now()
      await window.grasp.saveWorkflow(w)
      setActiveWf({ ...w })
    }
    w.status = 'done'
    w.updatedAt = Date.now()
    await window.grasp.saveWorkflow(w)
    setActiveWf({ ...w })
    void window.grasp.workflows().then(setWorkflows)
  }

  function createWorkflow(title: string, steps: string[]): void {
    setShowWfModal(false)
    const wf: WorkflowRecord = {
      id: crypto.randomUUID(),
      title,
      workspace,
      backend,
      model,
      steps: steps.map((prompt) => ({ prompt, status: 'pending' })),
      currentStep: 0,
      status: 'idle',
      history: [],
      updatedAt: Date.now()
    }
    setTranscript([])
    setSurface(null)
    void runWorkflow(wf)
  }

  // Restore the session list on launch.
  useEffect(() => {
    void window.grasp.sessions().then(setSessions)
  }, [])

  // Autosave: whenever a turn settles, persist the session (transcript + opaque history).
  useEffect(() => {
    if (busy || transcript.length === 0) return
    const firstUser = transcript.find((t) => t.role === 'user')
    const rec: SessionRecord = {
      id: sessionId,
      title: (firstUser?.text ?? 'Session').slice(0, 44),
      updatedAt: Date.now(),
      backend,
      model,
      workspace,
      transcript,
      history: history.current
    }
    void window.grasp.saveSession(rec)
    setSessions((ss) => [rec, ...ss.filter((s) => s.id !== rec.id)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, transcript])

  function loadSession(id: string): void {
    const rec = sessions.find((s) => s.id === id)
    if (!rec || busy) return
    setSessionId(rec.id)
    setTranscript(rec.transcript as TranscriptItem[])
    history.current = rec.history
    setBackend(rec.backend)
    setModel(rec.model)
    if (rec.workspace) setWorkspace(rec.workspace)
    setSurface(null)
    setError(null)
  }

  // Discover the agent backends (GLM / Claude Code / …) and default the model.
  useEffect(() => {
    void window.grasp.backends().then((bs) => {
      setBackends(bs)
      const first = bs.find((b) => b.id === 'glm') ?? bs[0]
      if (first) {
        setBackend(first.id)
        setModel(first.models[0] ?? '')
      }
    })
  }, [])

  // Switching provider mid-session starts fresh history (formats are backend-opaque).
  function pickBackend(id: string): void {
    setBackend(id)
    const b = backends.find((x) => x.id === id)
    setModel(b?.models[0] ?? '')
    history.current = []
  }

  // Apply + persist the color scheme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('grasp-theme', theme)
  }, [theme])

  // Populate the workspace from the resolved default so click-to-fuzz and the agent
  // share one repo without the user typing it.
  useEffect(() => {
    void window.grasp.defaultWorkspace().then((w) => setWorkspace((cur) => cur || w))
  }, [])

  // Click an input operand -> fuzz the input (schema inferred from the observed inputs)
  // -> surface the edge cases. Fuses flow + fuzz into one interactive object.
  async function vary(g: GraphModel): Promise<void> {
    const inputNode = g.nodes.find((n) => n.kind === 'input')
    if (!inputNode || varying) return
    const jtype = (v: unknown): string =>
      typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : 'string'
    const properties: Record<string, { type: string }> = {}
    const required: string[] = []
    for (const o of inputNode.operands) {
      properties[o.name] = { type: jtype(o.value) }
      required.push(o.name)
    }
    setVarying(true)
    const res = await window.grasp.fuzz({
      repo: workspace,
      entrypoint: g.entrypoint,
      schema: JSON.stringify({ type: 'object', properties, required }),
      variants: 24,
      allowEgress: fuzzReal
    })
    setVarying(false)
    if (res.ok && res.report) setSurface({ kind: 'fuzz', report: res.report })
    else setError(res.error ?? 'could not fuzz')
  }

  useEffect(() => {
    void window.grasp.keyStatus().then(setKeyReady)
  }, [])

  useEffect(() => {
    return window.grasp.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'text') setTranscript((t) => [...t, { role: 'assistant', text: e.text, parent: e.parent }])
      else if (e.type === 'tool_use')
        setTranscript((t) => [...t, { id: e.id, role: 'tool', name: e.name, input: e.input, status: 'running', parent: e.parent }])
      else if (e.type === 'tool_result')
        setTranscript((t) => t.map((it) => (it.id === e.id ? { ...it, summary: e.summary, status: 'done' } : it)))
      else if (e.type === 'dataflow') setSurface({ kind: 'flow', graph: e.graph })
      else if (e.type === 'dataflow_diff') setSurface({ kind: 'diff', diff: e.diff })
      else if (e.type === 'fuzz') setSurface({ kind: 'fuzz', report: e.report })
      else if (e.type === 'plan') setTranscript((t) => [...t, { role: 'plan', text: e.text }])
      else if (e.type === 'approval_request')
        setTranscript((t) => [...t, { role: 'approval', id: e.id, name: e.tool, input: e.input, status: 'running' }])
      else if (e.type === 'usage') setTokens((n) => n + e.input + e.output)
      else if (e.type === 'done') {
        setBusy(false)
        if (e.note) setTranscript((t) => [...t, { role: 'assistant', text: `_${e.note}_` }])
      }
      else if (e.type === 'error') {
        setError(e.error)
        setBusy(false)
      }
    })
  }, [])

  async function send(prompt: string, modeOverride?: 'auto' | 'ask' | 'plan'): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    setTranscript((t) => [...t, { role: 'user', text: prompt }])
    const watch = watchEp.trim() ? { entrypoint: watchEp.trim(), input: watchInput.trim() || undefined } : undefined
    const b = parseInt(budget, 10)
    const res = await window.grasp.agent({
      workspace,
      prompt,
      history: history.current,
      watch,
      backend,
      model,
      mode: modeOverride ?? agentMode,
      budget: Number.isFinite(b) && b > 0 ? b : undefined
    })
    history.current = res.messages
  }

  // Approving a plan executes it as a normal (build) turn — the plan text becomes the brief.
  function approvePlan(text: string): void {
    setAgentMode('auto')
    void send(`Execute this approved plan exactly as written. Do not re-plan.\n\n${text}`, 'auto')
  }

  function newSession(): void {
    setSessionId(crypto.randomUUID())
    history.current = []
    setTranscript([])
    setSurface(null)
    setError(null)
  }

  return (
    <div className="app">
      {keyReady === false && <KeyGate onSaved={() => setKeyReady(true)} />}
      {showWfModal && <WorkflowModal onCreate={createWorkflow} onClose={() => setShowWfModal(false)} />}

      <Sidebar
        workspace={workspace}
        onWorkspace={setWorkspace}
        onNewSession={newSession}
        sessions={sessions.map((s) => ({ id: s.id, title: s.title }))}
        activeSession={sessionId}
        onSelectSession={loadSession}
        onNewWorkflow={() => setShowWfModal(true)}
        theme={theme}
        onTheme={setTheme}
      />

      <Conversation
        transcript={transcript}
        busy={busy}
        error={error}
        backends={backends}
        backend={backend}
        model={model}
        mode={agentMode}
        tokens={tokens}
        budget={budget}
        onBudget={setBudget}
        onBackend={pickBackend}
        onModel={setModel}
        onMode={setAgentMode}
        onApprovePlan={approvePlan}
        onDecideApproval={decideApproval}
        onSend={send}
        banner={
          activeWf ? (
            <WorkflowPanel wf={activeWf} busy={busy} onResume={() => void runWorkflow(activeWf)} onDismiss={() => setActiveWf(null)} />
          ) : null
        }
      />

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
          <button
            className={`fuzz-toggle${fuzzReal ? ' real' : ''}`}
            onClick={() => setFuzzReal((r) => !r)}
            title={
              fuzzReal
                ? 'Fuzzing runs FOR REAL — network + side-effects fire on every variant. Click to wall it.'
                : 'Fuzzing is walled: network denied so N variants can’t fire real payments/calls. Click to fuzz for real.'
            }
          >
            fuzz: {fuzzReal ? 'real' : 'walled'}
          </button>
        </div>
        <div className="inst-body">
          {surface?.kind === 'diff' ? (
            <DataflowDiff diff={surface.diff} />
          ) : surface?.kind === 'fuzz' ? (
            <FuzzView report={surface.report} />
          ) : surface?.kind === 'flow' ? (
            <DataflowGraph graph={surface.graph} varying={varying} onVary={() => void vary(surface.graph)} />
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
