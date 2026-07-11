// grasp — the post-editor shell. Sidebar · conversation · the live dataflow instrument.
// You ask an agent to change code; as it works, the observed dataflow updates live on
// the right, ending in the question. Never a verdict.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar, type Theme } from './components/Sidebar'
import { Conversation, type TranscriptItem } from './components/Conversation'
import { DataflowGraph } from './components/DataflowGraph'
import { DataflowDiff } from './components/DataflowDiff'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels'
import { FuzzView } from './components/FuzzView'
import { FlowView, FlowDiffView, FuzzDiffView, IntroView } from './components/FlowView'
import { KeyGate } from './components/KeyGate'
import { WorkflowModal, WorkflowPanel } from './components/Workflow'
import { Settings } from './components/Settings'
import { RemoteConnect } from './components/RemoteConnect'
import { CommandPalette, type Command } from './components/CommandPalette'
import { TerminalDock } from './components/Terminal'
import { FilesPane } from './components/Files'
import { BrowserPane } from './components/Browser'
import { TrajectoryInspector } from './components/TrajectoryInspector'
import { GitGraphPane } from './components/GitGraph'
import { WikiPane } from './components/Wiki'
import { FlowWalk, walkAnchorsOf, type WalkAnchor } from './components/FlowWalk'
import { QuickOpen } from './components/QuickOpen'
import type { AgentEvent, BackendInfo, FlowStatus, FuzzReport, GraphDiffModel, GraphModel, IntroDoc, SessionRecord, SlashCommand, TrajectoryCall, WorkflowRecord } from '../../shared/types'
import type { ThoughtLevel } from '../../shared/catalog'
import type { TraceDoc, TraceDiff, FuzzDiff } from '../../shared/trace'

type Surface =
  | { kind: 'flow'; graph: GraphModel }
  | { kind: 'diff'; diff: GraphDiffModel }
  | { kind: 'fuzz'; report: FuzzReport }
  | { kind: 'trace'; ix: number }
  | { kind: 'tracediff'; diff: TraceDiff }
  | { kind: 'fuzzdiff'; fuzz: FuzzDiff }
  | { kind: 'intro'; intro: IntroDoc }

// The persona pill — grasp's two identities in one segmented control (Devin-style).
// Agent: the conversation-first shell. Editor: the full-window editor workspace.
function PersonaPill({ persona, onSwitch }: { persona: 'agent' | 'editor'; onSwitch: (p: 'agent' | 'editor') => void }): React.JSX.Element {
  const seg = (id: 'agent' | 'editor', label: string): React.JSX.Element => (
    <button
      key={id}
      className={`rounded-md px-2.5 py-0.5 text-[0.75rem] font-medium transition-colors ${persona === id ? 'bg-background text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`}
      onClick={() => onSwitch(id)}
    >
      {label}
    </button>
  )
  return (
    <span className="flex items-center rounded-lg bg-tag p-0.5" title="Switch persona (⌘G)">
      {seg('agent', 'Agent')}
      {seg('editor', 'Editor')}
    </span>
  )
}

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [calls, setCalls] = useState<TrajectoryCall[]>([]) // model-trajectory inspector records
  const [surface, setSurface] = useState<Surface | null>(null)
  const [traces, setTraces] = useState<TraceDoc[]>([])
  const [busy, setBusy] = useState(false)
  const [flowStatus, setFlowStatus] = useState<FlowStatus>('idle')
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
  const [agentMode, setAgentMode] = useState<'auto' | 'ask' | 'plan' | 'task'>('auto')
  const [thoughtLevel, setThoughtLevelState] = useState<ThoughtLevel | undefined>(() => (localStorage.getItem('grasp-thought') as ThoughtLevel) || undefined)
  const setThoughtLevel = (l: ThoughtLevel | undefined): void => {
    setThoughtLevelState(l)
    if (l) localStorage.setItem('grasp-thought', l)
    else localStorage.removeItem('grasp-thought')
  }
  const [rightTab, setRightTab] = useState<'editor' | 'flow' | 'trajectory' | 'browser' | 'git' | 'wiki'>('flow')
  const [flowLens, setFlowLens] = useState<'tree' | 'walk'>('tree') // Flow tab: the call tree | the walk narrative
  const [walkIx, setWalkIx] = useState<number | null>(null)
  const [bottomCollapsed, setBottomCollapsed] = useState(false)
  const [persona, setPersona] = useState<'agent' | 'editor'>(() => (localStorage.getItem('grasp-persona') === 'editor' ? 'editor' : 'agent'))
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [winW, setWinW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440))
  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Cap the sidebar to ~30% of the window so it never eats a disproportionate share at
  // small widths — keeps proportions consistent without forcing a "mobile" collapse.
  // The user's drag intent (200–420) is preserved; only the render is capped below it.
  const effectiveSidebarWidth = Math.min(sidebarWidth, Math.max(180, Math.round(winW * 0.3)))
  const startSidebarResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    const onMove = (ev: MouseEvent): void => setSidebarWidth(Math.max(200, Math.min(420, startW + ev.clientX - startX)))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const bottomRef = useRef<ImperativePanelHandle>(null)
  const rightRef = useRef<ImperativePanelHandle>(null)
  const conversationRef = useRef<ImperativePanelHandle>(null)
  const edDockRef = useRef<ImperativePanelHandle>(null) // editor persona: agent dock
  const edTermRef = useRef<ImperativePanelHandle>(null) // editor persona: terminal
  const [edTermCollapsed, setEdTermCollapsed] = useState(false)
  const [edMounted, setEdMounted] = useState(false) // editor persona visited once — mounts its terminal, then persists
  // Activity-rail click: open the pane to that tab, or collapse if it's already the active view.
  const pickRight = (tab: 'editor' | 'flow' | 'trajectory' | 'browser' | 'git' | 'wiki'): void => {
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
  const toggleEdDock = (): void => {
    const p = edDockRef.current
    if (!p) return
    p.isCollapsed() ? p.expand() : p.collapse()
  }
  const toggleEdTerm = (): void => {
    const p = edTermRef.current
    if (!p) return
    p.isCollapsed() ? p.expand() : p.collapse()
  }
  // Persona flip (Agent ⇄ Editor) — the inversion. Two full-window layouts, BOTH stay
  // mounted (display toggle only): the conversation, terminals, and open editor tabs all
  // survive a round trip. Persisted; ⌘G ('editor-persona' in keybindings) flips it.
  const togglePersona = (): void => setPersona((p) => (p === 'agent' ? 'editor' : 'agent'))
  useEffect(() => {
    localStorage.setItem('grasp-persona', persona)
    if (persona === 'editor') setEdMounted(true)
  }, [persona])
  // When the agent surfaces a Flow/trace, flip the right pane to Flow AND expand it if the
  // user collapsed it — otherwise the whole thesis is silently hidden with zero feedback.
  useEffect(() => {
    if (!surface) return
    setRightTab('flow')
    const p = rightRef.current
    if (p?.isCollapsed()) p.expand()
  }, [surface])

  // The Flow WALK: the current trace's meaningful frames as numbered anchors, in
  // execution order. Selecting an anchor opens the editor at its real file:line —
  // in whichever persona is active — and the tour pill walks prev/next from there.
  const walkAnchors = useMemo<WalkAnchor[]>(
    () => (surface?.kind === 'trace' && traces[surface.ix] ? walkAnchorsOf(traces[surface.ix]) : []),
    [surface, traces]
  )
  useEffect(() => {
    setWalkIx(null)
  }, [surface])
  // Open a workspace file at a line: the single click-to-source path (Flow tree, Walk,
  // diffs). Dispatches to every mounted FilesPane via the open-source bridge.
  const openSource = (file: string, line: number | null): void => {
    if (!file) return
    if (persona === 'agent') {
      setRightTab('editor')
      const p = rightRef.current
      if (p?.isCollapsed()) p.expand()
    }
    window.dispatchEvent(new CustomEvent('grasp:open-source', { detail: { file, line } }))
  }
  const tourTo = (ix: number): void => {
    const a = walkAnchors[ix]
    if (!a) return
    setWalkIx(ix) // selection always advances — a file-less anchor still walks
    if (a.file) openSource(a.file, a.line)
  }

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
      'toggle-terminal': () => (persona === 'editor' ? toggleEdTerm() : toggleBottom()),
      'toggle-sidebar': () => setSidebarOpen((s) => !s),
      'toggle-side-pane': () => (persona === 'editor' ? toggleEdDock() : toggleRight()),
      'editor-persona': togglePersona,
      'quick-open': () => setShowQuickOpen(true)
    }
    const onKey = (e: KeyboardEvent): void => {
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
  }, [keybinds, persona])
  const [tokens, setTokens] = useState(0)
  const [budget, setBudget] = useState('')
  const [queue, setQueue] = useState<string[]>([]) // follow-ups queued while the agent was busy

  // Resolve an Ask-mode approval and mark it decided in the transcript.
  function decideApproval(id: string, ok: boolean, scope: 'once' | 'session' | 'project' = 'once'): void {
    if (ok && scope !== 'once') {
      const it = transcript.find((x) => x.id === id)
      if (it?.capability && it.target) void window.grasp.grantPermission(workspace, it.capability, it.target, scope)
    }
    void window.grasp.approve(id, ok)
    setTranscript((t) => t.map((it) => (it.id === id ? { ...it, status: 'done', summary: ok ? (scope === 'project' ? 'allowed — always (project)' : scope === 'session' ? 'allowed — this session' : 'allowed') : 'denied' } : it)))
  }
  function decideElicitation(id: string, answer: string | null): void {
    void window.grasp.resolveElicitation(id, answer)
    setTranscript((t) => t.map((it) => (it.elicit?.id === id ? { ...it, elicitAnswer: answer } : it)))
  }
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID())
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const lastSession = useMemo(
    () => (sessions.length ? [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] : null),
    [sessions]
  )
  const agoLabel = (t: number): string => {
    const s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 90) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
  }
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([])
  const [activeWf, setActiveWf] = useState<WorkflowRecord | null>(null)
  const [showWfModal, setShowWfModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showRemote, setShowRemote] = useState(false)
  const [remote, setRemote] = useState<{ host: string; user: string; cwd: string } | null>(null)
  const [showPalette, setShowPalette] = useState(false)
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  // Esc stops a running agent (the standard escape hatch) — only when no overlay is open, so
  // it never fights the palette/settings/workflow modal. Separate from the keybinds effect so
  // it can reference these overlay states (declared just above) cleanly.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && busy && !showPalette && !showSettings && !showWfModal && !showRemote && !showQuickOpen) {
        e.preventDefault()
        e.stopPropagation()
        void window.grasp.stopAgent()
      }
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [busy, showPalette, showSettings, showWfModal, showRemote, showQuickOpen])
  const [skills, setSkills] = useState<{ name: string; description: string; source: string; enabled: boolean }[]>([])
  const [mcpServers, setMcpServers] = useState<Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; transport?: string; disabled?: boolean; disabledTools?: string[] }>>({})
  const [plugins, setPlugins] = useState<{ name: string; description: string; source: 'user' | 'project'; hasSkills: boolean; mcpCount: number }[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const history = useRef<unknown[]>([])
  const taskRef = useRef<{ phases: string[] } | null>(null) // the Task loop pipeline (verify → review)
  const justLoadedRef = useRef(false) // skip one autosave after opening a session — viewing is not editing
  const editPaths = useRef(new Map<string, string>()) // tool_use id → edited path (auto-reload)
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
  function openWorkflow(id: string): void {
    const w = workflows.find((x) => x.id === id)
    if (w) setActiveWf(w) // surfaces the panel; its Resume button runs/resumes
  }
  function deleteWorkflowById(id: string): void {
    void window.grasp.deleteWorkflow(id).then(() => {
      setWorkflows((ws) => ws.filter((w) => w.id !== id))
      if (activeWf?.id === id) setActiveWf(null)
    })
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

  // Restore the session LIST on launch — and nothing else. Boot lands quiet: no
  // auto-opened transcript, no repo work, until the human picks a session, a
  // workspace, or runs Load repo. (Auto-restore-last was ZCode parity; rejected —
  // sessions are isolated and nothing continues on its own.)
  useEffect(() => {
    void window.grasp.sessions().then(setSessions)
  }, [])

  // Autosave: whenever a turn settles, persist the session (transcript + opaque history).
  useEffect(() => {
    if (busy || transcript.length === 0) return
    if (justLoadedRef.current) {
      justLoadedRef.current = false
      return
    }
    const firstUser = transcript.find((t) => t.role === 'user')
    const existing = sessions.find((s) => s.id === sessionId)
    const rec: SessionRecord = {
      id: sessionId,
      title: existing?.titleUserSet ? existing.title : (firstUser?.text ?? 'Session').slice(0, 44),
      titleUserSet: existing?.titleUserSet ?? false,
      updatedAt: Date.now(),
      backend,
      model,
      workspace,
      transcript,
      history: history.current,
      calls,
      traces,
      surface
    }
    void window.grasp.saveSession(rec)
    setSessions((ss) => [rec, ...ss.filter((s) => s.id !== rec.id)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, transcript, calls, traces, surface])

  function applySession(rec: SessionRecord): void {
    justLoadedRef.current = true
    setSessionId(rec.id)
    setTranscript(rec.transcript as TranscriptItem[])
    history.current = rec.history
    setCalls((rec.calls ?? []) as TrajectoryCall[])
    setTraces((rec.traces ?? []) as TraceDoc[]) // isolate: never inherit the previous session's traces
    setBackend(rec.backend)
    setModel(rec.model)
    if (rec.workspace) setWorkspace(rec.workspace)
    setSurface((rec.surface ?? null) as Surface | null)
    setError(null)
    setFlowStatus('idle')
    taskRef.current = null
    setQueue([])
    setTokens(0)
    setWalkIx(null)
    setBudget('')
    setFlowLens('tree')
    setFlowNote(null)
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
  function renameSessionById(id: string, title: string): void {
    void window.grasp.renameSession(id, title).then(() => {
      setSessions((ss) => ss.map((s) => (s.id === id ? { ...s, title, titleUserSet: true } : s)))
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

  // NO autoload. A model turn never starts itself: the workspace introduction runs
  // only from the explicit Load repo affordance (empty-state button, palette, /start).
  // The old auto-intro fired on every boot and workspace switch — a model call with
  // no user action, and the "session sprawl" bug in real use. Rejected for good.

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
      else if (e.type === 'thinking_delta')
        setTranscript((t) => {
          const last = t[t.length - 1]
          if (last && last.role === 'assistant' && last.thinkingStreaming) {
            const copy = t.slice()
            copy[copy.length - 1] = { ...last, thinking: (last.thinking ?? '') + e.text }
            return copy
          }
          return [...t, { role: 'assistant', thinking: e.text, thinkingStreaming: true, streaming: false }]
        })
      else if (e.type === 'thinking_end')
        setTranscript((t) => t.map((it, idx) => idx === t.length - 1 && it.thinkingStreaming
          ? { ...it, thinkingStreaming: false, thinkingMs: e.ms }
          : it))
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
      else if (e.type === 'tool_use') {
        // Remember which file an edit tool touches; on its result, tell open buffers.
        const p = (e.input as { path?: unknown } | undefined)?.path
        if ((e.name === 'write_file' || e.name === 'edit_file' || e.name === 'notebook_edit') && typeof p === 'string') editPaths.current.set(e.id, p)
        setTranscript((t) => [...t, { id: e.id, role: 'tool', name: e.name, input: e.input, status: 'running', parent: e.parent }])
      } else if (e.type === 'tool_result') {
        const edited = editPaths.current.get(e.id)
        if (edited) {
          editPaths.current.delete(e.id)
          window.dispatchEvent(new CustomEvent('grasp:file-changed', { detail: { file: edited } }))
        }
        setTranscript((t) => t.map((it) => (it.id === e.id ? { ...it, summary: e.summary, output: e.output, status: 'done' } : it)))
      }
      else if (e.type === 'trajectory_call') setCalls((cs) => [...cs, e.call])
      else if (e.type === 'checkpoint')
        // Pin the baseline to the user message that started THIS turn — it is the last
        // item exactly then. Never scan back: a headless/steered turn must not stamp an
        // older bubble.
        setTranscript((t) => {
          const last = t[t.length - 1]
          if (!last || last.role !== 'user' || last.checkpointSha) return t
          const c = t.slice()
          c[c.length - 1] = { ...last, checkpointSha: e.sha }
          return c
        })
      else if (e.type === 'dataflow') setSurface({ kind: 'flow', graph: e.graph })
      else if (e.type === 'dataflow_diff') setSurface({ kind: 'diff', diff: e.diff })
      else if (e.type === 'fuzz') setSurface({ kind: 'fuzz', report: e.report })
      else if (e.type === 'trace')
        setTraces((ts) => {
          const next = [...ts, e.trace]
          setSurface({ kind: 'trace', ix: next.length - 1 })
          setRightTab('flow')
          return next
        })
      else if (e.type === 'trace_diff') { setSurface({ kind: 'tracediff', diff: e.diff }); setRightTab('flow') }
      else if (e.type === 'fuzz_diff') { setSurface({ kind: 'fuzzdiff', fuzz: e.fuzz }); setRightTab('flow') }
      else if (e.type === 'intro') { setSurface({ kind: 'intro', intro: e.intro }); setRightTab('flow') }
      else if (e.type === 'plan') { setTranscript((t) => [...t, { role: 'plan', text: e.text }]); setFlowStatus('awaiting-approval') }
      else if (e.type === 'approval_request')
        setTranscript((t) => [...t, { role: 'approval', id: e.id, name: e.tool, input: e.input, status: 'running', capability: e.capability, target: e.target }])
      else if (e.type === 'elicitation_request')
        setTranscript((t) => [...t, { role: 'elicitation', elicit: { id: e.id, header: e.header, question: e.question, options: e.options, multiSelect: e.multiSelect } }])
      else if (e.type === 'usage') setTokens((n) => n + e.input + e.output)
      else if (e.type === 'hook') setTranscript((t) => [...t, { role: 'hook', hook: { event: e.event, tool: e.tool, output: e.output } }])
      else if (e.type === 'done') {
        setBusy(false)
        if (!taskRef.current) setFlowStatus('done') // during a Task, keep flowStatus so the pipeline advances
        setTranscript((t) => t.map((it) => (it.streaming ? { ...it, streaming: false } : it)))
        if (e.note) setTranscript((t) => [...t, { role: 'assistant', text: `_${e.note}_` }])
      }
      else if (e.type === 'error') {
        setError(e.error)
        setBusy(false)
        setFlowStatus('failed')
        setTranscript((t) => t.map((it) => (it.streaming ? { ...it, streaming: false } : it)))
      }
    })
  }, [])

  async function send(prompt: string, modeOverride?: 'auto' | 'ask' | 'plan'): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    const chosen = modeOverride ?? agentMode
    const isTask = chosen === 'task'
    if (isTask) taskRef.current = { phases: ['verify', 'review'] }
    const turnMode: 'auto' | 'ask' | 'plan' = isTask ? 'plan' : chosen
    const turnPrompt = isTask
      ? `TASK OBJECTIVE: ${prompt}\n\nYou are running as a Task with a completion criterion. First, PRODUCE A CONCRETE PLAN: the implementation steps, AND the command that will VERIFY it works (tests / lint / typecheck). Define what "done" means. Do NOT implement yet — plan only.`
      : prompt
    setFlowStatus(turnMode === 'plan' ? 'planning' : 'executing')
    setTranscript((t) => [...t, { role: 'user', text: isTask ? `📋 ${prompt}` : prompt, histLen: history.current.length }])
    const b = parseInt(budget, 10)
    const res = await window.grasp.agent({
      workspace,
      prompt: turnPrompt,
      history: history.current,
      backend,
      model,
      thoughtLevel,
      mode: turnMode,
      budget: Number.isFinite(b) && b > 0 ? b : undefined,
      flowAuto
    })
    history.current = res.messages
  }

  // Steer: inject a message into the in-flight turn (drained by the owned loop each step).
  function steerPrompt(text: string): void {
    void window.grasp.steer(text)
    setTranscript((t) => [...t, { role: 'user', text: `↳ ${text}` }])
  }

  // Compact: summarize the conversation so far into a handover, replacing the backend
  // history with that summary so the next turn starts from a compressed context.
  async function compactConversation(): Promise<void> {
    if (busy) return
    const lines = transcript
      .filter((it) => (it.role === 'user' || it.role === 'assistant') && it.text)
      .map((it) => `${it.role === 'user' ? 'User' : 'Assistant'}: ${(it.text ?? '').replace(/\s+/g, ' ').slice(0, 800)}`)
    if (lines.length < 4) { setError('Not enough conversation to compact yet.'); return }
    setBusy(true)
    const sys = "Summarize the conversation into a concise handover for a coding agent: the user's goal, decisions made, what was changed (with file paths/commands/values), and the open question or next step. Reply with ONLY the summary, no preamble."
    const res = await window.grasp.oneShot({ backend, model, system: sys, user: lines.join('\n\n'), maxTokens: 1024 })
    setBusy(false)
    if (!res.ok || !res.text) { setError(res.error ?? 'compaction failed'); return }
    history.current = [{ role: 'user', content: `<conversation summary>\n${res.text}` }]
    setTranscript((t) => [...t, { role: 'assistant', text: '_✦ Context compacted — earlier turns summarized into the next turn._' }])
    setTokens(0)
  }

  // Lifeguard: on-demand "check changes" — diff vs HEAD, then a one-shot review that
  // surfaces factual concerns as neutral questions (no verdicts — on-thesis).
  async function checkChanges(): Promise<void> {
    if (busy) return
    const d = await window.grasp.gitDiff(workspace)
    if (!d.ok) { setError(d.error ?? 'git diff failed'); return }
    if (!d.diff) { setError('No uncommitted changes to check.'); return }
    setBusy(true)
    const sys = "You review a code diff for a coding agent (Lifeguard). Surface ONLY factual, observable concerns a reader should verify — as neutral questions, each ending in '?'. Example: 'the loop now skips index 0 — intended?'. Do NOT use verdict words (bug/risk/safe/pass/broken/fail). If nothing is worth asking about, reply exactly 'No concerns surfaced.' No preamble — just the bulleted questions."
    const res = await window.grasp.oneShot({ backend, model, system: sys, user: d.diff, maxTokens: 1024 })
    setBusy(false)
    if (!res.ok || !res.text) { setError(res.error ?? 'check failed'); return }
    setTranscript((t) => [...t, { role: 'assistant', text: `**Lifeguard — change check**\n\n${res.text}` }])
  }

  // Revert: reset the workspace files to the state before a step (its pre-turn
  // baseline commit) and rewind the chat to that point. A recovery checkpoint is
  // committed first and reported as a fact — the revert itself is always undoable.
  async function revertToStep(index: number): Promise<void> {
    const it = transcript[index]
    if (busy || !it || it.role !== 'user' || !it.checkpointSha) return
    const sha = it.checkpointSha
    const r = await window.grasp.revertTo(workspace, sha)
    if (!r.ok) {
      setError(r.error ?? 'revert failed')
      return
    }
    if (it.histLen != null) history.current = history.current.slice(0, it.histLen)
    setQueue([]) // queued follow-ups aimed at the pre-revert state must not fire
    setTranscript((t) => [
      ...t.slice(0, index),
      { role: 'assistant', text: `⟲ **Reverted** the workspace to the state before this step (\`${sha.slice(0, 7)}\`).${r.safeSha ? ` The pre-revert state is committed as \`${r.safeSha.slice(0, 7)}\` — recover with \`git reset --hard ${r.safeSha.slice(0, 7)}\`.` : ''}` }
    ])
    setSurface(null)
    window.dispatchEvent(new CustomEvent('grasp:workspace-reverted'))
  }

  // Fork: branch the conversation at a user message — a new session carrying the context
  // up to that prompt (the turn's pre-history) and the transcript through it. The current
  // session is preserved by the autosave effect; this just spins a fresh id for the branch.
  function forkFromUser(index: number): void {
    if (busy) return
    const item = transcript[index]
    if (!item || item.role !== 'user' || item.histLen == null) return
    setSessionId(crypto.randomUUID())
    history.current = history.current.slice(0, item.histLen)
    setTranscript(transcript.slice(0, index + 1))
    setCalls([])
    setSurface(null)
    setError(null)
  }

  // Drain the queue when a turn goes idle — send one follow-up per idle transition.
  useEffect(() => {
    if (busy || taskRef.current) return // don't interleave with a Task pipeline
    let next: string | undefined
    setQueue((q) => { if (q.length) { next = q[0]; return q.slice(1) } return q })
    if (next !== undefined) void send(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // The Task loop: after each EXECUTING turn (implement, then verify), advance the pipeline.
  // verify = run the repo's tests + fix until green; review = Lifeguard check-changes.
  const VERIFY_PROMPT = "VERIFY the change you just made. Discover the repo's test command (package.json \"scripts.test\", Makefile, pyproject [tool.pytest], Cargo test, go test, etc.) and run it, plus lint and typecheck if they exist. If anything fails, FIX it and re-run — up to 3 rounds. Then report the final state plainly: GREEN, or exactly what still fails. Do not claim success if a check failed."
  useEffect(() => {
    if (busy || flowStatus !== 'executing') return
    const t = taskRef.current
    if (!t) return
    if (!t.phases.length) { taskRef.current = null; setFlowStatus('done'); return }
    const next = t.phases.shift()
    if (next === 'verify') void send(VERIFY_PROMPT, 'auto')
    else if (next === 'review') void checkChanges()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, flowStatus])

  // Approving a plan executes it as a normal (build) turn — the plan text becomes the brief.
  function approvePlan(text: string): void {
    setAgentMode('auto')
    setFlowStatus('executing')
    void send(`Execute this approved plan exactly as written. Do not re-plan.\n\n${text}`, 'auto')
  }

  function newSession(): void {
    if (busy) void window.grasp.stopAgent() // never leak a running turn into a fresh session
    taskRef.current = null
    setQueue([])
    setTokens(0)
    setWalkIx(null)
    setBudget('')
    setFlowLens('tree')
    setFlowNote(null)
    setSessionId(crypto.randomUUID())
    history.current = []
    setTranscript([])
    setCalls([])
    setSurface(null)
    setError(null)
    setFlowStatus('idle')
  }

  function switchProject(path: string): void {
    if (!path || path === workspace) return
    setWorkspace(path)
    newSession()
  }

  // Remote SSH workspace (VS Code Remote-SSH): on connect the workspace switches to the
  // remote home and the agent + editor + terminal route over the persistent ssh2 session.
  function connectRemote(r: { host: string; user: string; cwd: string }): void {
    setRemote(r)
    setWorkspace(r.cwd)
    newSession()
  }
  async function disconnectRemote(): Promise<void> {
    await window.grasp.remoteDisconnect()
    setRemote(null)
    void window.grasp.defaultWorkspace().then((w) => setWorkspace(w))
    newSession()
  }

  function deleteSessionById(id: string): void {
    if (id === sessionId && busy) void window.grasp.stopAgent()
    void window.grasp.deleteSession(id).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    setSessions((ss) => ss.filter((s) => s.id !== id))
    if (id === sessionId) newSession()
  }

  // The conversation element — ONE definition rendered in both personas (the chat
  // pane in Agent, the right-hand agent dock in Editor). All state lives in App, so
  // both chromes drive the same session.
  const conversationView = (
              <Conversation
                transcript={transcript}
                busy={busy}
                error={error}
                backends={backends}
                backend={backend}
                model={model}
                mode={agentMode}
                flowStatus={flowStatus}
                tokens={tokens}
                budget={budget}
                onBudget={setBudget}
                onCompact={compactConversation}
                onCheck={checkChanges}
                onForkUser={forkFromUser}
                onRevertUser={(i) => void revertToStep(i)}
                onLoadRepo={skills.some((s) => s.name === 'load-repo' && s.enabled) ? () => void send('Use the "load-repo" skill.') : undefined}
                resume={transcript.length === 0 && lastSession ? { label: `${lastSession.title.slice(0, 32)} · ${agoLabel(lastSession.updatedAt)}`, onResume: () => loadSession(lastSession.id) } : undefined}
                onBackend={pickBackend}
                onModel={setModel}
                thoughtLevel={thoughtLevel}
                onThoughtLevel={setThoughtLevel}
                onMode={setAgentMode}
                onQueue={(t) => setQueue((q) => [...q, t])}
                onSteer={steerPrompt}
                queue={queue}
                onRemoveQueued={(i) => setQueue((q) => q.filter((_, ix) => ix !== i))}
                onApprovePlan={approvePlan}
                onDecideApproval={decideApproval}
                onDecideElicitation={decideElicitation}
                onSend={send}
                onStop={() => void window.grasp.stopAgent()}
                onRegenerate={() => {
                  const lastUser = [...transcript].reverse().find((it) => it.role === 'user')
                  if (lastUser?.text) void send(lastUser.text)
                }}
                onReact={(index, reaction) => setTranscript((t) => t.map((it, i) => i === index ? { ...it, reaction } : it))}
                commands={commands}
                skills={skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description }))}
                onToggleTerminal={() => (persona === 'editor' ? toggleEdTerm() : toggleBottom())}
                onToggleSidebar={() => (persona === 'editor' ? toggleEdDock() : setSidebarOpen((s) => !s))}
                workspace={workspace}
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
  )

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {keyReady === false && <KeyGate onSaved={() => setKeyReady(true)} />}
      {showWfModal && <WorkflowModal onCreate={createWorkflow} onClose={() => setShowWfModal(false)} />}
      {showRemote && <RemoteConnect onClose={() => setShowRemote(false)} onConnected={connectRemote} />}
      {showSettings && (
        <Settings theme={theme} onTheme={setTheme} onKeysChanged={refreshBackends} skills={skills} onSkillsChanged={refreshSkills} mcpServers={mcpServers} onMcpChanged={refreshMcpServers} plugins={plugins} onPluginsChanged={refreshPlugins} commands={commands} keybinds={keybinds} workspace={workspace} onClose={() => setShowSettings(false)} />
      )}
      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          items={[
            { id: 'new-session', group: 'Command', label: 'New session', hint: '⌘N', run: newSession },
            { id: 'new-workflow', group: 'Command', label: 'New workflow', run: () => setShowWfModal(true) },
            { id: 'connect-remote', group: 'Command', label: 'Connect remote…', run: () => setShowRemote(true) },
            { id: 'open-folder', group: 'Command', label: 'Open folder…', run: () => void window.grasp.openFolder().then((p) => p && switchProject(p)) },
            { id: 'settings', group: 'Command', label: 'Settings', run: () => setShowSettings(true) },
            { id: 'view-terminal', group: 'View', label: 'Toggle terminal', hint: '⌃`', run: toggleBottom },
            { id: 'view-sidebar', group: 'View', label: 'Toggle sidebar', hint: '⌘B', run: () => setSidebarOpen((s) => !s) },
            { id: 'view-side', group: 'View', label: 'Toggle side pane', hint: '⌘L', run: toggleRight },
            { id: 'switch-persona', group: 'View', label: 'Switch persona — Agent ⇄ Editor', hint: '⌘G', run: togglePersona },
            { id: 'quick-open', group: 'View', label: 'Go to file…', hint: '⌘P', run: () => setShowQuickOpen(true) },
            ...(skills.some((s) => s.name === 'load-repo' && s.enabled)
              ? [{ id: 'load-repo', group: 'Command', label: 'Load repo — introduce this workspace', run: () => void send('Use the "load-repo" skill.') } as Command]
              : []),
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
      {showQuickOpen && (
        <QuickOpen
          workspace={workspace}
          onClose={() => setShowQuickOpen(false)}
          onPick={(f) => {
            setShowQuickOpen(false)
            openSource(f, null)
          }}
        />
      )}

      {/* AGENT persona — the whole current grasp shell, untouched. Hidden (never
          unmounted) while the Editor persona is active, so everything survives. */}
      <div className={`min-w-0 flex-1 ${persona === 'agent' ? 'flex' : 'hidden'}`}>
      {sidebarOpen && (
        <div className="flex shrink-0 flex-col h-full border-r border-border overflow-hidden" style={{ width: effectiveSidebarWidth }}>
          <Sidebar
            workspace={workspace}
          onWorkspace={switchProject}
          onNewSession={newSession}
          sessions={sessions.map((s) => ({ id: s.id, title: s.title, workspace: s.workspace, updatedAt: s.updatedAt }))}
          activeSession={sessionId}
          onSelectSession={loadSession}
          onForkSession={forkSessionById}
          onRenameSession={renameSessionById}
          onDeleteSession={deleteSessionById}
          workflows={workflows.map((w) => ({
            id: w.id,
            title: w.title,
            status: w.status,
            done: w.steps.filter((s) => s.status === 'done').length,
            total: w.steps.length
          }))}
          activeWorkflow={activeWf?.id ?? null}
          onOpenWorkflow={openWorkflow}
          onDeleteWorkflow={deleteWorkflowById}
          skills={skills}
          onToggleSkill={(name, enabled) => void window.grasp.setSkillEnabled(name, enabled).then(refreshSkills)}
          onSearch={() => setShowPalette(true)}
          onNewWorkflow={() => setShowWfModal(true)}
          onSettings={() => setShowSettings(true)}
          onRemote={() => setShowRemote(true)}
          theme={theme}
          onTheme={setTheme}
        />
        </div>
      )}
      {sidebarOpen && <div className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-border z-50" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} onMouseDown={startSidebarResize} />}

      <div className="flex min-w-0 flex-1 flex-col bg-background">
      <PanelGroup direction="vertical" className="min-h-0 flex-1" autoSaveId="grasp-vert">
        <Panel defaultSize={72} minSize={30}>
          <PanelGroup direction="horizontal" autoSaveId="grasp-horz">
            {/* chat */}
            <Panel defaultSize={54} minSize={20} ref={conversationRef} className="min-w-0">
              {remote && (
                <div className="flex shrink-0 items-center gap-2 border-b border-accent-blue/30 bg-accent-blue/10 px-4 py-1.5 text-[0.75rem]">
                  <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent-blue" />
                  <span className="font-medium text-accent-blue">SSH</span>
                  <span className="text-foreground-subtle">
                    <span className="font-mono text-foreground">{remote.user}@{remote.host}</span>
                    <span className="mx-1.5 text-foreground-subtlest">·</span>
                    <span className="font-mono">{remote.cwd}</span>
                  </span>
                  <span className="ml-auto text-foreground-subtlest">agent + editor run on this remote</span>
                  <button className="rounded-md border border-border bg-card px-2 py-0.5 text-[0.6875rem] font-medium text-foreground-subtle transition-colors hover:text-foreground" onClick={() => void disconnectRemote()}>Disconnect</button>
                </div>
              )}
              {conversationView}
            </Panel>
            <PanelResizeHandle className="w-px shrink-0 bg-border" />
            {/* editor / flow / browser — the tall side pane */}
            <Panel
              ref={rightRef}
              defaultSize={46}
              minSize={22}
              collapsible
              collapsedSize={0}
              onCollapse={() => setRightCollapsed(true)}
              onExpand={() => setRightCollapsed(false)}
              className="flex min-h-0 flex-col bg-panel"
            >
              <div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-panel px-3 pt-1.5">
                <span className="mb-1 mr-2 shrink-0">
                  <PersonaPill persona={persona} onSwitch={setPersona} />
                </span>
                <button className={`border-b-2 px-3 pb-1.5 text-[0.8125rem] font-medium transition-colors ${rightTab === 'editor' ? 'border-foreground text-foreground' : 'border-transparent text-foreground-subtlest hover:text-foreground-subtle'}`} onClick={() => setRightTab('editor')}>Editor</button>
                <button className={`border-b-2 px-3 pb-1.5 text-[0.8125rem] font-medium transition-colors ${rightTab === 'flow' ? 'border-foreground text-foreground' : 'border-transparent text-foreground-subtlest hover:text-foreground-subtle'}`} onClick={() => setRightTab('flow')}>Flow</button>
                <button className={`border-b-2 px-3 pb-1.5 text-[0.8125rem] font-medium transition-colors ${rightTab === 'trajectory' ? 'border-foreground text-foreground' : 'border-transparent text-foreground-subtlest hover:text-foreground-subtle'}`} onClick={() => setRightTab('trajectory')}>Trajectory</button>
                <button className={`border-b-2 px-3 pb-1.5 text-[0.8125rem] font-medium transition-colors ${rightTab === 'browser' ? 'border-foreground text-foreground' : 'border-transparent text-foreground-subtlest hover:text-foreground-subtle'}`} onClick={() => setRightTab('browser')}>Browser</button>
                <button className={`border-b-2 px-3 pb-1.5 text-[0.8125rem] font-medium transition-colors ${rightTab === 'git' ? 'border-foreground text-foreground' : 'border-transparent text-foreground-subtlest hover:text-foreground'}`} onClick={() => setRightTab('git')}>Git</button>
                <button className={`border-b-2 px-3 pb-1.5 text-[0.8125rem] font-medium transition-colors ${rightTab === 'wiki' ? 'border-foreground text-foreground' : 'border-transparent text-foreground-subtlest hover:text-foreground'}`} onClick={() => setRightTab('wiki')}>Wiki</button>
                {surface && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[0.6875rem] text-foreground-subtlest">
                    <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                    live
                  </span>
                )}
                <button className="ml-auto border-0 bg-transparent px-1.5 py-0.5 text-[0.875rem] text-foreground-subtlest transition-colors hover:text-foreground" onClick={toggleRight} title="Close side pane (⌘\)">✕</button>
              </div>
              <div className="relative min-h-0 flex-1">
                <div className={`absolute inset-0 ${rightTab === 'editor' ? 'visible' : 'hidden'}`}>
                  <FilesPane workspace={workspace} active={rightTab === 'editor'} walk={{ anchors: walkAnchors, currentIx: walkIx, onTour: tourTo }} trace={surface?.kind === 'trace' ? traces[surface.ix] ?? null : null} />
                </div>
                <div className={`absolute inset-0 ${rightTab === 'browser' ? 'visible' : 'hidden'}`}>
                  <BrowserPane active={rightTab === 'browser'} />
                </div>
                <div className={`absolute inset-0 ${rightTab === 'git' ? 'visible' : 'hidden'}`}>
                  <GitGraphPane workspace={workspace} active={rightTab === 'git'} />
                </div>
                <div className={`absolute inset-0 ${rightTab === 'wiki' ? 'visible' : 'hidden'}`}>
                  <WikiPane workspace={workspace} backend={backend} model={model} active={rightTab === 'wiki'} />
                </div>
                <div className={`absolute inset-0 ${rightTab === 'trajectory' ? 'visible' : 'hidden'}`}>
                  <TrajectoryInspector calls={calls} />
                </div>
                <div className={`absolute inset-0 flex flex-col ${rightTab === 'flow' ? 'visible' : 'hidden'}`}>
                  <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                    <button className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.75rem] transition-colors ${flowAuto ? 'bg-tag text-foreground' : 'text-foreground-subtlest hover:bg-surface-hover'}`} onClick={toggleFlowAuto} title={flowAuto ? 'Auto: re-observes after every edit' : 'On demand: click Run flow'}>
                      <span className="size-1.5 rounded-full bg-current opacity-60" />
                      auto
                    </button>
                    <button className="rounded-md bg-secondary px-2.5 py-1 text-[0.75rem] font-medium text-foreground transition-filter hover:brightness-110 disabled:opacity-50" disabled={flowRunning} onClick={() => void runFlowNow()}>
                      {flowRunning ? 'observing…' : '▶ Run flow'}
                    </button>
                    {surface?.kind === 'trace' && (
                      <span className="ml-auto flex items-center rounded-md bg-tag p-0.5 text-[0.6875rem]">
                        <button className={`rounded px-2 py-0.5 transition-colors ${flowLens === 'tree' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => setFlowLens('tree')}>Tree</button>
                        <button className={`rounded px-2 py-0.5 transition-colors ${flowLens === 'walk' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => setFlowLens('walk')}>Walk</button>
                      </span>
                    )}

                  </div>
                  {flowNote && <div className="shrink-0 border-b border-border px-3 py-1 text-[0.75rem] text-foreground-subtlest">{flowNote}</div>}
                  <div className="min-h-0 flex-1 overflow-hidden">
                  {surface?.kind === 'fuzzdiff' ? (
                    <FuzzDiffView
                      fuzz={surface.fuzz}
                      onAdjudicate={(p) => void send(p)}
                      onOpenSource={openSource}
                    />
                  ) : surface?.kind === 'intro' ? (
                    <IntroView intro={surface.intro} onPickFlow={(name) => void send(`Show the real Flow of: ${name}`)} />
                  ) : surface?.kind === 'tracediff' ? (
                    <FlowDiffView
                      diff={surface.diff}
                      onOpenSource={openSource}
                    />
                  ) : surface?.kind === 'trace' && traces[surface.ix] ? (
                    <>
                      {traces.length > 1 && (
                        <div className="flex shrink-0 gap-1 border-b border-border px-3 py-1.5">
                          {traces.map((tr, i) => (
                            <button key={tr.id} className={`rounded-full px-2.5 py-0.5 text-[0.6875rem] transition-colors ${i === surface.ix ? 'bg-selected text-foreground' : 'text-foreground-subtlest hover:bg-surface-hover'}`} onClick={() => setSurface({ kind: 'trace', ix: i })} title={tr.entry}>
                              {i === traces.length - 1 ? 'latest' : `run ${i + 1}`}
                            </button>
                          ))}
                        </div>
                      )}
                      {flowLens === 'walk' ? (
                        <FlowWalk trace={traces[surface.ix]} anchors={walkAnchors} currentIx={walkIx} onSelect={tourTo} workspace={workspace} />
                      ) : (
                        <FlowView trace={traces[surface.ix]} onOpenSource={openSource} />
                      )}
                    </>
                  ) : surface?.kind === 'diff' ? (
                    <DataflowDiff diff={surface.diff} />
                  ) : surface?.kind === 'fuzz' ? (
                    <FuzzView report={surface.report} />
                  ) : surface?.kind === 'flow' ? (
                    <DataflowGraph graph={surface.graph} varying={varying} onVary={() => void vary(surface.graph)} />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-10 text-center">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-surface text-foreground-subtlest">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" /><path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.7" /></svg>
                      </div>
                      <p className="text-[0.875rem] font-medium text-foreground">Observed dataflow</p>
                      <p className="max-w-[300px] text-[0.8125rem] leading-relaxed text-foreground-subtlest">
                        Ask the agent to run a function. The real values it binds and the paths it takes appear here — ending in a question, never a verdict.
                      </p>
                    </div>
                  )}
                  </div>
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="h-px shrink-0 bg-border" />
        {/* docked terminal */}
        <Panel
          ref={bottomRef}
          defaultSize={26}
          minSize={10}
          collapsible
          collapsedSize={0}
          onCollapse={() => setBottomCollapsed(true)}
          onExpand={() => setBottomCollapsed(false)}
          className="border-t border-border bg-panel"
        >
          <TerminalDock workspace={workspace} active={!bottomCollapsed} onCloseDock={toggleBottom} />
        </Panel>
      </PanelGroup>

      {/* status bar */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-background px-3.5 text-[0.71875rem] text-foreground-subtle">
        <span className="inline-flex items-center gap-1.5 font-mono" title={workspace}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.7" /></svg>
          {workspace.split('/').filter(Boolean).pop() ?? 'no project'}
        </span>
        <button className={`ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.71875rem] transition-colors ${bottomCollapsed ? 'text-foreground-subtlest hover:bg-surface-hover' : 'bg-surface text-foreground'}`} onClick={toggleBottom} title="Toggle terminal (⌃`)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Terminal
          <span className="font-mono text-[0.625rem] text-foreground-subtlest">⌃`</span>
        </button>
      </div>
      </div>

      {/* activity rail */}
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-border bg-background py-2">
        {(['editor', 'flow', 'trajectory', 'browser'] as const).map((t) => (
          <button
            key={t}
            className={`relative flex size-[34px] items-center justify-center rounded-lg border-0 bg-transparent transition-colors ${!rightCollapsed && rightTab === t ? 'bg-surface text-foreground' : 'text-foreground-subtlest hover:bg-surface-hover hover:text-foreground-subtle'}`}
            onClick={() => pickRight(t)}
            title={t[0].toUpperCase() + t.slice(1)}
          >
            {t === 'editor' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 3v18M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.7" /></svg>
            ) : t === 'flow' ? (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" /><path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.7" /></svg>
                {surface && rightCollapsed && <span className="absolute right-1 top-1 size-[7px] rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-background)]" title="new Flow — click to view" />}
              </>
            ) : t === 'trajectory' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" stroke="currentColor" strokeWidth="1.5" /></svg>
            )}
          </button>
        ))}
        <button
          className="mt-auto flex size-[34px] items-center justify-center rounded-lg border-0 bg-transparent text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
          onClick={() => setShowRemote(true)}
          title="Connect to a remote environment"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
        </button>
        <button
          className="flex size-[34px] items-center justify-center rounded-lg border-0 bg-transparent text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
          onClick={() => setShowSettings(true)}
          title="Settings — MCP, plugins, skills, keybindings, commands"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" stroke="currentColor" strokeWidth="1.7" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
      </div>
      </div>

      {/* EDITOR persona — the inversion: a full-window editor workspace in the same
          window. Its FilesPane is persona-owned; the flip is instant, nothing unmounts. */}
      <div className={`min-w-0 flex-1 flex-col ${persona === 'editor' ? 'flex' : 'hidden'}`}>
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-panel px-3" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          <span style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <PersonaPill persona={persona} onSwitch={setPersona} />
          </span>
          <span className="truncate font-mono text-[0.75rem] text-foreground-subtle" title={workspace}>
            {workspace.split('/').filter(Boolean).pop() ?? 'no project'}
          </span>
          <button
            className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={togglePersona}
            title="Switch to the Agent persona (⌘G)"
          >
            ⇄ Agent
            <span className="font-mono text-foreground-subtlest">⌘G</span>
          </button>
        </div>
        <PanelGroup direction="vertical" className="min-h-0 flex-1" autoSaveId="grasp-editor-vert">
          <Panel defaultSize={74} minSize={30}>
            <PanelGroup direction="horizontal" autoSaveId="grasp-editor-horz">
              <Panel defaultSize={70} minSize={30} className="min-w-0">
                <FilesPane workspace={workspace} active={persona === 'editor'} walk={{ anchors: walkAnchors, currentIx: walkIx, onTour: tourTo }} trace={surface?.kind === 'trace' ? traces[surface.ix] ?? null : null} />
              </Panel>
              <PanelResizeHandle className="w-px shrink-0 bg-border" />
              {/* the agent, docked — the same conversation in editor chrome (⌘L toggles) */}
              <Panel ref={edDockRef} defaultSize={30} minSize={18} collapsible collapsedSize={0} className="flex min-h-0 flex-col border-l border-border bg-background">
                {conversationView}
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="h-px shrink-0 bg-border" />
          {/* docked terminal (⌃` toggles) — mounts on first Editor visit, then persists */}
          <Panel ref={edTermRef} defaultSize={26} minSize={10} collapsible collapsedSize={0} onCollapse={() => setEdTermCollapsed(true)} onExpand={() => setEdTermCollapsed(false)} className="border-t border-border bg-panel">
            {edMounted && <TerminalDock workspace={workspace} active={persona === 'editor' && !edTermCollapsed} onCloseDock={toggleEdTerm} />}
          </Panel>
        </PanelGroup>
      </div>
    </div>
  )
}
