// grasp — the post-editor shell. Sidebar · conversation · the live dataflow instrument.
// You ask an agent to change code; as it works, the observed dataflow updates live on
// the right, ending in the question. Never a verdict.
import { useEffect, useRef, useState } from 'react'
import { Sidebar, type Theme } from './components/Sidebar'
import { Conversation, type TranscriptItem } from './components/Conversation'
import { DataflowGraph } from './components/DataflowGraph'
import { DataflowDiff } from './components/DataflowDiff'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels'
import { FuzzView } from './components/FuzzView'
import { FlowView, FlowDiffView, FuzzDiffView } from './components/FlowView'
import { KeyGate } from './components/KeyGate'
import { WorkflowModal, WorkflowPanel } from './components/Workflow'
import { Settings } from './components/Settings'
import { CommandPalette, type Command } from './components/CommandPalette'
import { TerminalDock } from './components/Terminal'
import { FilesPane } from './components/Files'
import { BrowserPane } from './components/Browser'
import type { AgentEvent, BackendInfo, FuzzReport, GraphDiffModel, GraphModel, SessionRecord, SlashCommand, WorkflowRecord } from '../../shared/types'
import type { TraceDoc, TraceDiff, FuzzDiff } from '../../shared/trace'

type Surface =
  | { kind: 'flow'; graph: GraphModel }
  | { kind: 'diff'; diff: GraphDiffModel }
  | { kind: 'fuzz'; report: FuzzReport }
  | { kind: 'trace'; ix: number }
  | { kind: 'tracediff'; diff: TraceDiff }
  | { kind: 'fuzzdiff'; fuzz: FuzzDiff }

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [surface, setSurface] = useState<Surface | null>(null)
  const [traces, setTraces] = useState<TraceDoc[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyReady, setKeyReady] = useState<boolean | null>(null)
  const [varying, setVarying] = useState(false)
  // Flow auto-refresh: on = re-observe after every agent edit; off (DEFAULT) = build first,
  // run the Flow on demand via the CTA when you're ready to inspect behavior.
  const [flowAuto, setFlowAuto] = useState<boolean>(() => localStorage.getItem('grasp-flow-auto') === 'on')
  const [flowNote, setFlowNote] = useState<string | null>(null)
  const [flowRunning, setFlowRunning] = useState(false)

  function toggleFlowAuto(): void {
    setFlowAuto((a) => {
      localStorage.setItem('grasp-flow-auto', a ? 'off' : 'on')
      return !a
    })
  }

  async function runFlowNow(): Promise<void> {
    if (flowRunning) return
    setFlowNote(null)
    setFlowRunning(true)
    const r = await window.grasp.flowNow(workspace)
    setFlowRunning(false)
    if (!r.ok) setFlowNote(r.error ?? 'could not run the flow')
  }
  const [fuzzReal] = useState(false) // false = walled (network denied); toggled in the fuzz view
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('grasp-theme') as Theme) || 'graphite')
  const [backends, setBackends] = useState<BackendInfo[]>([])
  const [backend, setBackend] = useState('glm')
  const [model, setModel] = useState('')
  const [agentMode, setAgentMode] = useState<'auto' | 'ask' | 'plan'>('auto')
  const [rightTab, setRightTab] = useState<'editor' | 'flow' | 'browser'>('flow')
  const [bottomCollapsed, setBottomCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const bottomRef = useRef<ImperativePanelHandle>(null)
  const rightRef = useRef<ImperativePanelHandle>(null)
  // Activity-rail click: open the pane to that tab, or collapse if it's already the active view.
  const pickRight = (tab: 'editor' | 'flow' | 'browser'): void => {
    const p = rightRef.current
    if (!p) return
    if (!p.isCollapsed() && rightTab === tab) p.collapse()
    else {
      p.expand()
      setRightTab(tab)
    }
  }
  const toggleBottom = (): void => {
    const p = bottomRef.current
    if (!p) return
    p.isCollapsed() ? p.expand() : p.collapse()
  }
  const toggleRight = (): void => {
    const p = rightRef.current
    if (!p) return
    p.isCollapsed() ? p.expand() : p.collapse()
  }
  // When the agent surfaces a Flow/trace, flip the right pane to Flow AND expand it if the
  // user collapsed it — otherwise the whole thesis is silently hidden with zero feedback.
  useEffect(() => {
    if (!surface) return
    setRightTab('flow')
    const p = rightRef.current
    if (p?.isCollapsed()) p.expand()
  }, [surface])

  // Keybindings — driven by ~/.grasp/keybindings.json (loaded from the main process). Chord
  // grammar: mod+<key> (Cmd on mac, Ctrl elsewhere), or ctrl+/cmd+/shift+/alt+ combos.
  const [keybinds, setKeybinds] = useState<Record<string, string>>({})
  useEffect(() => {
    void window.grasp.keybindings().then(setKeybinds)
  }, [])
  useEffect(() => {
    const chordOf = (e: KeyboardEvent): string =>
      [e.metaKey && 'cmd', e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', e.key.toLowerCase()]
        .filter(Boolean)
        .join('+')
    const matches = (cfg: string, e: KeyboardEvent): boolean => {
      if (!(e.metaKey || e.ctrlKey)) return false // never hijack un-modified typing
      const c = cfg.toLowerCase()
      if (c.startsWith('mod+')) {
        const rest = c.slice(4)
        return chordOf(e) === 'cmd+' + rest || chordOf(e) === 'ctrl+' + rest
      }
      return chordOf(e) === c
    }
    const actions: Record<string, () => void> = {
      'new-session': newSession,
      'command-palette': () => setShowPalette((p) => !p),
      'toggle-terminal': toggleBottom,
      'toggle-sidebar': () => setSidebarOpen((s) => !s),
      'toggle-side-pane': toggleRight
    }
    const onKey = (e: KeyboardEvent): void => {
      // Esc stops a running agent (the standard escape hatch) — only when no overlay is open,
      // so it never fights the palette/settings/modal.
      if (e.key === 'Escape' && busy && !showPalette && !showSettings && !showWfModal) {
        e.preventDefault()
        e.stopPropagation()
        void window.grasp.stopAgent()
        return
      }
      for (const [action, chord] of Object.entries(keybinds)) {
        if (matches(chord, e)) {
          const fn = actions[action]
          if (fn) {
            e.preventDefault()
            e.stopPropagation()
            fn()
            return
          }
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keybinds, busy, showPalette, showSettings, showWfModal])
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
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [skills, setSkills] = useState<{ name: string; description: string; source: string; enabled: boolean }[]>([])
  const [mcpServers, setMcpServers] = useState<Record<string, { command: string; args?: string[] }>>({})
  const [plugins, setPlugins] = useState<{ name: string; description: string; source: 'user' | 'project'; hasSkills: boolean; mcpCount: number }[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const history = useRef<unknown[]>([])
  const wfCancelRef = useRef(false)
  useEffect(() => {
    if (workspace) {
      void window.grasp.skills(workspace).then(setSkills)
      void window.grasp.commands(workspace).then(setCommands)
      void window.grasp.mcpServers(workspace).then(setMcpServers)
      void window.grasp.plugins(workspace).then(setPlugins)
    }
  }, [workspace])
  const refreshBackends = (): void => {
    void window.grasp.backends().then(setBackends)
  }
  const refreshSkills = (): void => {
    if (workspace) void window.grasp.skills(workspace).then(setSkills)
  }
  const refreshMcpServers = (): void => {
    if (workspace) void window.grasp.mcpServers(workspace).then(setMcpServers)
  }
  const refreshPlugins = (): void => {
    if (workspace) void window.grasp.plugins(workspace).then(setPlugins)
  }

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
  async function runWorkflow(base: WorkflowRecord, fromStep?: number): Promise<void> {
    if (busy) return
    wfCancelRef.current = false
    const w: WorkflowRecord = { ...base, status: 'running' }
    if (fromStep !== undefined) {
      // retry from a specific step: rewind to it and mark it pending (keeps prior history)
      w.currentStep = fromStep
      w.steps = w.steps.map((s, idx) => (idx === fromStep ? { ...s, status: 'pending' } : s))
    }
    for (let i = w.currentStep; i < w.steps.length; i++) {
      if (wfCancelRef.current) break
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
        model: w.model,
        budget: w.budget,
        flowAuto
      })
      setBusy(false)
      if (wfCancelRef.current) {
        // cancelled mid-step: leave it pending (re-runnable), then pause
        w.steps = w.steps.map((s, idx) => (idx === i ? { ...s, status: 'pending' } : s))
      } else {
        w.history = res.messages
        w.steps = w.steps.map((s, idx) => (idx === i ? { ...s, status: 'done' } : s))
        w.currentStep = i + 1
      }
      w.updatedAt = Date.now()
      await window.grasp.saveWorkflow(w)
      setActiveWf({ ...w })
      if (wfCancelRef.current) {
        w.status = 'paused'
        w.updatedAt = Date.now()
        await window.grasp.saveWorkflow(w)
        setActiveWf({ ...w })
        return
      }
    }
    w.status = wfCancelRef.current ? 'paused' : 'done'
    w.updatedAt = Date.now()
    await window.grasp.saveWorkflow(w)
    setActiveWf({ ...w })
    void window.grasp.workflows().then(setWorkflows)
  }

  function cancelWorkflow(): void {
    wfCancelRef.current = true
    void window.grasp.stopAgent()
  }

  function createWorkflow(title: string, steps: string[], budget?: number): void {
    setShowWfModal(false)
    const wf: WorkflowRecord = {
      id: crypto.randomUUID(),
      title,
      workspace,
      backend,
      model,
      budget,
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

  function applySession(rec: SessionRecord): void {
    setSessionId(rec.id)
    setTranscript(rec.transcript as TranscriptItem[])
    history.current = rec.history
    setBackend(rec.backend)
    setModel(rec.model)
    if (rec.workspace) setWorkspace(rec.workspace)
    setSurface(null)
    setError(null)
  }
  function loadSession(id: string): void {
    const rec = sessions.find((s) => s.id === id)
    if (!rec || busy) return
    applySession(rec)
  }
  function forkSessionById(id: string): void {
    if (busy) return
    void window.grasp.forkSession(id).then((newId) => {
      if (!newId) return
      void window.grasp.sessions().then((ss) => {
        setSessions(ss)
        const fork = ss.find((x) => x.id === newId)
        if (fork) applySession(fork) // switch straight into the fork
      })
    })
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
      else if (e.type === 'text_delta')
        // Append to the active streaming bubble, or start one. One bubble per model response.
        setTranscript((t) => {
          const last = t[t.length - 1]
          if (last && last.role === 'assistant' && last.streaming) {
            const copy = t.slice()
            copy[copy.length - 1] = { ...last, text: (last.text ?? '') + e.text }
            return copy
          }
          return [...t, { role: 'assistant', text: e.text, streaming: true, parent: e.parent }]
        })
      else if (e.type === 'text_end')
        setTranscript((t) => (t.some((it) => it.streaming) ? t.map((it) => (it.streaming ? { ...it, streaming: false } : it)) : t))
      else if (e.type === 'tool_use')
        setTranscript((t) => [...t, { id: e.id, role: 'tool', name: e.name, input: e.input, status: 'running', parent: e.parent }])
      else if (e.type === 'tool_result')
        setTranscript((t) => t.map((it) => (it.id === e.id ? { ...it, summary: e.summary, output: e.output, status: 'done' } : it)))
      else if (e.type === 'dataflow') setSurface({ kind: 'flow', graph: e.graph })
      else if (e.type === 'dataflow_diff') setSurface({ kind: 'diff', diff: e.diff })
      else if (e.type === 'fuzz') setSurface({ kind: 'fuzz', report: e.report })
      else if (e.type === 'trace')
        setTraces((ts) => {
          const next = [...ts, e.trace]
          setSurface({ kind: 'trace', ix: next.length - 1 })
          return next
        })
      else if (e.type === 'trace_diff') setSurface({ kind: 'tracediff', diff: e.diff })
      else if (e.type === 'fuzz_diff') setSurface({ kind: 'fuzzdiff', fuzz: e.fuzz })
      else if (e.type === 'plan') setTranscript((t) => [...t, { role: 'plan', text: e.text }])
      else if (e.type === 'approval_request')
        setTranscript((t) => [...t, { role: 'approval', id: e.id, name: e.tool, input: e.input, status: 'running' }])
      else if (e.type === 'usage') setTokens((n) => n + e.input + e.output)
      else if (e.type === 'done') {
        setBusy(false)
        setTranscript((t) => t.map((it) => (it.streaming ? { ...it, streaming: false } : it)))
        if (e.note) setTranscript((t) => [...t, { role: 'assistant', text: `_${e.note}_` }])
      }
      else if (e.type === 'error') {
        setError(e.error)
        setBusy(false)
        setTranscript((t) => t.map((it) => (it.streaming ? { ...it, streaming: false } : it)))
      }
    })
  }, [])

  async function send(prompt: string, modeOverride?: 'auto' | 'ask' | 'plan'): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    setTranscript((t) => [...t, { role: 'user', text: prompt }])
    const b = parseInt(budget, 10)
    const res = await window.grasp.agent({
      workspace,
      prompt,
      history: history.current,
      backend,
      model,
      mode: modeOverride ?? agentMode,
      budget: Number.isFinite(b) && b > 0 ? b : undefined,
      flowAuto
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

  function switchProject(path: string): void {
    if (!path || path === workspace) return
    setWorkspace(path)
    newSession()
  }

  function deleteSessionById(id: string): void {
    void window.grasp.deleteSession(id)
    setSessions((ss) => ss.filter((s) => s.id !== id))
    if (id === sessionId) newSession()
  }

  return (
    <div className="app">
      {keyReady === false && <KeyGate onSaved={() => setKeyReady(true)} />}
      {showWfModal && <WorkflowModal onCreate={createWorkflow} onClose={() => setShowWfModal(false)} />}
      {showSettings && (
        <Settings theme={theme} onTheme={setTheme} onKeysChanged={refreshBackends} skills={skills} onSkillsChanged={refreshSkills} mcpServers={mcpServers} onMcpChanged={refreshMcpServers} plugins={plugins} onPluginsChanged={refreshPlugins} onClose={() => setShowSettings(false)} />
      )}
      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          items={[
            { id: 'new-session', group: 'Command', label: 'New session', hint: '⌘N', run: newSession },
            { id: 'new-workflow', group: 'Command', label: 'New workflow', run: () => setShowWfModal(true) },
            { id: 'open-folder', group: 'Command', label: 'Open folder…', run: () => void window.grasp.openFolder().then((p) => p && switchProject(p)) },
            { id: 'settings', group: 'Command', label: 'Settings', run: () => setShowSettings(true) },
            { id: 'view-terminal', group: 'View', label: 'Toggle terminal', hint: '⌃`', run: toggleBottom },
            { id: 'view-sidebar', group: 'View', label: 'Toggle sidebar', hint: '⌘B', run: () => setSidebarOpen((s) => !s) },
            { id: 'view-side', group: 'View', label: 'Toggle side pane', hint: '⌘L', run: toggleRight },
            ...skills.filter((s) => s.enabled).map(
              (s): Command => ({
                id: 'skill-' + s.name,
                group: 'Skill',
                label: s.name,
                hint: s.description.slice(0, 44),
                run: () => void send(`Use the "${s.name}" skill.`)
              })
            ),
            ...commands.map(
              (c): Command => ({
                id: 'cmd-' + c.name,
                group: 'Command',
                label: '/' + c.name,
                hint: c.description.slice(0, 44) || (c.skills ? `skill: ${c.skills}` : ''),
                run: () => {
                  // $ARGUMENTS/$N aren't reachable from the palette yet — strip them.
                  const body = c.body.replace(/\$ARGUMENTS/g, '').replace(/\$\d+/g, '').trim()
                  void send(c.skills ? `Use the "${c.skills}" skill, then follow these instructions:\n\n${body}` : body)
                }
              })
            ),
            ...sessions.map(
              (s): Command => ({ id: 'sess-' + s.id, group: 'Session', label: s.title, run: () => loadSession(s.id) })
            )
          ]}
        />
      )}

      {sidebarOpen && (
        <Sidebar
          workspace={workspace}
          onWorkspace={switchProject}
          onNewSession={newSession}
          sessions={sessions.map((s) => ({ id: s.id, title: s.title }))}
          activeSession={sessionId}
          onSelectSession={loadSession}
          onForkSession={forkSessionById}
          onDeleteSession={deleteSessionById}
          onSearch={() => setShowPalette(true)}
          onNewWorkflow={() => setShowWfModal(true)}
          onSettings={() => setShowSettings(true)}
          theme={theme}
          onTheme={setTheme}
        />
      )}

      <div className="workarea">
      <PanelGroup direction="vertical" className="panels" autoSaveId="grasp-vert">
        <Panel defaultSize={72} minSize={30}>
          <PanelGroup direction="horizontal" autoSaveId="grasp-horz">
            {/* chat */}
            <Panel defaultSize={54} minSize={28} className="col chat-col">
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
                onStop={() => void window.grasp.stopAgent()}
                onToggleTerminal={toggleBottom}
                onToggleSidebar={() => setSidebarOpen((s) => !s)}
                banner={
                  activeWf ? (
                    <WorkflowPanel
                      wf={activeWf}
                      busy={busy}
                      onResume={() => void runWorkflow(activeWf)}
                      onCancel={cancelWorkflow}
                      onRetry={(i) => void runWorkflow(activeWf, i)}
                      onDismiss={() => setActiveWf(null)}
                    />
                  ) : null
                }
              />
            </Panel>
            <PanelResizeHandle className="rh rh-v" />
            {/* editor / flow / browser — the tall side pane */}
            <Panel
              ref={rightRef}
              defaultSize={46}
              minSize={22}
              collapsible
              collapsedSize={0}
              onCollapse={() => setRightCollapsed(true)}
              onExpand={() => setRightCollapsed(false)}
              className="col right-col"
            >
              <div className="panebar">
                <button className={rightTab === 'editor' ? 'on' : ''} onClick={() => setRightTab('editor')}>
                  Editor
                </button>
                <button className={rightTab === 'flow' ? 'on' : ''} onClick={() => setRightTab('flow')}>
                  Flow
                </button>
                <button className={rightTab === 'browser' ? 'on' : ''} onClick={() => setRightTab('browser')}>
                  Browser
                </button>
                {surface && (
                  <span className="pane-live">
                    <span className="pulse" />
                    live
                  </span>
                )}
                <button className="dock-toggle" onClick={toggleRight} title="Close side pane (⌘\)">
                  ✕
                </button>
              </div>
              <div className="pane-body">
                <div className={`pane${rightTab === 'editor' ? ' on' : ''}`}>
                  <FilesPane workspace={workspace} active={rightTab === 'editor'} />
                </div>
                <div className={`pane${rightTab === 'browser' ? ' on' : ''}`}>
                  <BrowserPane active={rightTab === 'browser'} />
                </div>
                <div className={`pane flow-pane${rightTab === 'flow' ? ' on' : ''}`}>
                  <div className="flow-controls">
                    <button
                      className={`flow-auto${flowAuto ? ' on' : ''}`}
                      onClick={toggleFlowAuto}
                      title={
                        flowAuto
                          ? 'Auto: the Flow re-observes after every agent edit. Click to switch to on-demand.'
                          : 'On demand: the Flow only runs when you click Run flow. Click to switch to auto.'
                      }
                    >
                      <span className="fa-dot" />
                      auto
                    </button>
                    <button className="btn sm flow-run" disabled={flowRunning} onClick={() => void runFlowNow()}>
                      {flowRunning ? 'observing…' : '▶ Run flow'}
                    </button>
                  </div>
                  {flowNote && <div className="flow-note">{flowNote}</div>}
                  {surface?.kind === 'fuzzdiff' ? (
                    <FuzzDiffView
                      fuzz={surface.fuzz}
                      onOpenSource={(file) => {
                        setRightTab('editor')
                        void window.grasp.readFile(workspace, file)
                      }}
                    />
                  ) : surface?.kind === 'tracediff' ? (
                    <FlowDiffView
                      diff={surface.diff}
                      onOpenSource={(file) => {
                        setRightTab('editor')
                        void window.grasp.readFile(workspace, file)
                      }}
                    />
                  ) : surface?.kind === 'trace' && traces[surface.ix] ? (
                    <>
                      {traces.length > 1 && (
                        <div className="fl-runs">
                          {traces.map((tr, i) => (
                            <button
                              key={tr.id}
                              className={`fl-run${i === surface.ix ? ' on' : ''}`}
                              onClick={() => setSurface({ kind: 'trace', ix: i })}
                              title={tr.entry}
                            >
                              {i === traces.length - 1 ? 'latest' : `run ${i + 1}`}
                            </button>
                          ))}
                        </div>
                      )}
                      <FlowView
                        trace={traces[surface.ix]}
                        onOpenSource={(file) => {
                          setRightTab('editor')
                          void window.grasp.readFile(workspace, file)
                        }}
                      />
                    </>
                  ) : surface?.kind === 'diff' ? (
                    <DataflowDiff diff={surface.diff} />
                  ) : surface?.kind === 'fuzz' ? (
                    <FuzzView report={surface.report} />
                  ) : surface?.kind === 'flow' ? (
                    <DataflowGraph graph={surface.graph} varying={varying} onVary={() => void vary(surface.graph)} />
                  ) : (
                    <div className="inst-empty">
                      This is where grasp shows the <b>observed dataflow</b> — the real values a function binds and
                      the paths it takes{flowAuto ? ', re-observed after every edit' : ''}. It fills in as soon as
                      the agent runs a function through grasp (any language){flowAuto ? '' : ' — or when you click Run flow'}.
                      Code with no callable entrypoint yet — a pure UI handler, a not-yet-wired module — stays blank
                      here until there&rsquo;s something to run. It ends in a question, never a verdict.
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="rh rh-h" />
        {/* docked terminal — wide+short belongs here; the browser lives in the side pane */}
        <Panel
          ref={bottomRef}
          defaultSize={26}
          minSize={10}
          collapsible
          collapsedSize={0}
          onCollapse={() => setBottomCollapsed(true)}
          onExpand={() => setBottomCollapsed(false)}
          className="bottom-dock"
        >
          <TerminalDock workspace={workspace} active={!bottomCollapsed} onCloseDock={toggleBottom} />
        </Panel>
      </PanelGroup>

      {/* status bar — persistent call-to-action for the terminal + project */}
      <div className="statusbar">
        <span className="sb-project" title={workspace}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.7" /></svg>
          {workspace.split('/').filter(Boolean).pop() ?? 'no project'}
        </span>
        <button className={`sb-btn${bottomCollapsed ? '' : ' on'}`} onClick={toggleBottom} title="Toggle terminal (⌃`)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Terminal
          <span className="sb-key">⌃`</span>
        </button>
      </div>
      </div>

      {/* activity rail — VSCode-style; reopens the side pane on click */}
      <div className="activity-rail">
        {(['editor', 'flow', 'browser'] as const).map((t) => (
          <button
            key={t}
            className={`act-btn${!rightCollapsed && rightTab === t ? ' on' : ''}`}
            onClick={() => pickRight(t)}
            title={t[0].toUpperCase() + t.slice(1)}
          >
            {t === 'editor' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 3v18M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.7" /></svg>
            ) : t === 'flow' ? (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" /><path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.7" /></svg>
                {surface && rightCollapsed && <span className="act-badge" title="new Flow — click to view" />}
              </>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" stroke="currentColor" strokeWidth="1.5" /></svg>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
