// The conversation: product-grade message rendering. Markdown with real syntax-highlighted
// code blocks (copy + collapse), subtle inline code, and TOOL CALLS as clean collapsible
// blocks. Plus plan cards, approval cards, nested subagents, a working provider/model picker,
// a token meter, and a slash-command menu. Fully migrated to Tailwind v4.
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { EditorIcon } from './editor-icons'
import type { BackendInfo, SlashCommand, FlowStatus } from '../../../shared/types'
import { THOUGHT_LABEL, hasReasoning, lookupModel, type ThoughtLevel } from '../../../shared/catalog'

export interface TranscriptItem {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'plan' | 'approval' | 'elicitation' | 'hook'
  text?: string
  thinking?: string
  thinkingMs?: number
  thinkingStreaming?: boolean
  name?: string
  input?: Record<string, unknown>
  capability?: string
  target?: string
  summary?: string
  output?: string
  status?: 'running' | 'done'
  parent?: string
  streaming?: boolean
  reaction?: 'up' | 'down'
  elicit?: { id: string; header?: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }
  elicitAnswer?: string | null
  histLen?: number // backend-history length captured when this user turn was sent (for Fork)
  checkpointSha?: string // the turn's pre-edit baseline commit (for Revert)
  hook?: { event: string; tool?: string; output: string } // a lifecycle-hook output line
}

const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

// ── code blocks ─────────────────────────────────────────────
function CodeBlock({ lang, code }: { lang: string; code: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const lineCount = code.split('\n').length
  const [collapsed, setCollapsed] = useState(lineCount > 24)
  const html = useMemo(() => {
    try {
      return lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value
    } catch {
      return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
    }
  }, [code, lang])
  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-1.5">
        <span className="text-[0.6875rem] font-medium text-foreground-subtlest">{lang || 'text'}</span>
        <button className="text-[0.6875rem] text-foreground-subtlest transition-colors hover:text-foreground-subtle" onClick={copy}>
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre className={`overflow-auto p-4 font-mono text-[0.8125rem] leading-relaxed text-foreground ${collapsed ? 'max-h-[60px]' : ''}`}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {lineCount > 24 && (
        <button className="w-full border-t border-border py-1 text-center text-[0.6875rem] text-foreground-subtlest transition-colors hover:text-foreground-subtle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? `▸ show all ${lineCount} lines` : '▾ collapse'}
        </button>
      )}
    </div>
  )
}

const markdownComponents = {
  code({ className, children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
    const text = String(children ?? '').replace(/\n$/, '')
    const m = /language-(\w+)/.exec(className || '')
    if (m || text.includes('\n')) return <CodeBlock lang={m ? m[1] : ''} code={text} />
    return <code className="rounded bg-tag px-1 py-0.5 font-mono text-[0.75rem]">{children}</code>
  },
  pre({ children }: { children?: React.ReactNode }): React.JSX.Element {
    return <>{children}</>
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }): React.JSX.Element {
    return (
      <a
        className="text-foreground underline underline-offset-2 hover:text-foreground-subtle"
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) window.open(href, '_blank')
        }}
      >
        {children}
      </a>
    )
  }
}

// ── tool calls ──────────────────────────────────────────────
function describe(it: TranscriptItem): { verb: string; arg: string } {
  const path = String(it.input?.path ?? it.input?.file_path ?? '')
  const cmd = String(it.input?.command ?? '').replace(/\s+/g, ' ').trim()
  const ep = String(it.input?.entrypoint ?? '')
  switch (it.name) {
    case 'write_file': case 'Write': return { verb: 'Wrote', arg: base(path) }
    case 'Edit': case 'MultiEdit': return { verb: 'Edited', arg: base(path) }
    case 'read_file': case 'Read': return { verb: 'Read', arg: base(path) }
    case 'list_dir': case 'LS': return { verb: 'Listed', arg: base(path) || '.' }
    case 'run_bash': case 'Bash': return { verb: 'Ran', arg: cmd.slice(0, 60) || 'command' }
    case 'use_skill': case 'Skill': return { verb: 'Skill', arg: String(it.input?.name ?? '') || 'loaded' }
    case 'grasp_observe': return { verb: 'Observed', arg: ep }
    case 'grasp_diff': return { verb: 'Diffed', arg: ep }
    case 'grasp_fuzz': return { verb: 'Fuzzed', arg: ep }
    case 'grasp_flow': {
      const tf = String(it.input?.trace_file ?? '')
      const inlineEntry = /"entry"\s*:\s*"([^"]+)"/.exec(String(it.input?.trace ?? ''))?.[1] ?? ''
      return { verb: 'Flow', arg: tf ? base(tf) : (inlineEntry || 'inline trace') }
    }
    case 'grasp_flow_diff': {
      const of = String(it.input?.old_file ?? '')
      return { verb: 'A→B flow', arg: of ? base(of) : 'old vs new' }
    }
    case 'grasp_fuzz_diff': {
      const e = String(it.input?.entry ?? '')
      const cf = String(it.input?.cases_file ?? '')
      return { verb: 'Fuzz-diff', arg: e || (cf ? base(cf) : 'cases') }
    }
    case 'task': case 'Task': return { verb: 'Delegated', arg: String(it.input?.description ?? it.input?.prompt ?? '').slice(0, 60) }
    default: return { verb: it.name ?? 'Tool', arg: path || cmd.slice(0, 60) }
  }
}

function ToolBlock({ it }: { it: TranscriptItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { verb, arg } = describe(it)
  const cmd = it.name === 'run_bash' || it.name === 'Bash' ? String(it.input?.command ?? '') : ''
  const running = it.status !== 'done'
  const inputDetail = useMemo(() => {
    if (cmd) return null
    const inp = { ...(it.input ?? {}) }
    if (typeof inp.content === 'string') inp.content = `(${(inp.content as string).length} chars — see Editor)`
    const keys = Object.keys(inp)
    if (keys.length === 0) return null
    return JSON.stringify(inp, null, 2)
  }, [cmd, it.input])
  return (
    <div className="group/tool my-0.5">
      <div
        className="inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-[0.8125rem] outline-none"
        onClick={() => setOpen((o) => !o)}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
      >
        <span className={`text-[0.625rem] transition-transform ${open ? 'rotate-90' : ''} text-foreground-subtlest opacity-0 group-hover/tool:opacity-100 ${open ? 'opacity-100' : ''}`}>▸</span>
        <span className={`shrink-0 font-medium whitespace-nowrap ${running ? 'text-foreground' : 'text-foreground-subtlest'}`}>{verb}</span>
        <span className="truncate font-mono text-[0.75rem] text-foreground">{arg}</span>
        {running && (
          <span className="ml-1 size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-foreground border-r-transparent" />
        )}
      </div>
      {open && (
        <div className="mt-1.5 rounded-xl border border-border bg-panel px-4 py-3">
          {cmd && <CodeBlock lang="bash" code={cmd} />}
          {inputDetail && <CodeBlock lang="json" code={inputDetail} />}
          {it.output ? (
            <pre className="mt-2 max-h-[100px] overflow-auto whitespace-pre-wrap break-words font-mono text-[0.8125rem] text-foreground-subtle">{it.output}</pre>
          ) : (
            <p className="font-mono text-[0.8125rem] text-foreground-subtle">{running ? 'running…' : 'no captured output for this call'}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── provider/model picker ───────────────────────────────────
function ModelPicker(props: {
  backends: BackendInfo[]; backend: string; model: string
  onBackend: (id: string) => void; onModel: (m: string) => void
}): React.JSX.Element {
  const active = props.backends.find((b) => b.id === props.backend)
  const meta = lookupModel(props.backend, props.model)
  const ctx = meta?.contextWindow ? `${Math.round(meta.contextWindow / 1000)}k` : null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[0.75rem] text-foreground-subtle">
      <span className={`size-1.5 rounded-full ${active?.ok ? 'bg-foreground' : 'bg-foreground-subtlest'}`} title={active?.ok ? 'available' : (active?.reason ?? 'unavailable')} />
      <select
        className="border-0 bg-transparent text-[0.75rem] text-foreground-subtle outline-none"
        value={props.backend}
        onChange={(e) => props.onBackend(e.target.value)}
        title="agent backend"
      >
        {props.backends.map((b) => (<option key={b.id} value={b.id}>{b.label}</option>))}
      </select>
      <span className="text-foreground-subtlest">/</span>
      <select
        className="border-0 bg-transparent text-[0.75rem] text-foreground-subtle outline-none"
        value={props.model}
        onChange={(e) => props.onModel(e.target.value)}
        title={meta ? `model · ${meta.contextWindow ? Math.round(meta.contextWindow / 1000) + 'k ctx' : ''}${meta.maxOutputTokens ? ' · ' + Math.round(meta.maxOutputTokens / 1000) + 'k out' : ''}${meta.inputModalities?.length ? ' · ' + meta.inputModalities.join('+') : ''}`.replace('  ', ' ').trim() : 'model'}
      >
        {(active?.models ?? []).map((m) => (<option key={m} value={m}>{m}</option>))}
      </select>
      {ctx && <span className="text-foreground-subtlest" title="context window">{ctx}</span>}
    </span>
  )
}

// ── reasoning / thought-level picker (cycle: Auto → low → medium → high → max → off) ──
const THOUGHT_CYCLE: (ThoughtLevel | undefined)[] = [undefined, 'low', 'medium', 'high', 'max', 'off']
function ThoughtLevelPicker(props: {
  backend: string; model: string
  level: ThoughtLevel | undefined
  onLevel: (l: ThoughtLevel | undefined) => void
}): React.JSX.Element | null {
  // Hidden for models with no reasoning control (e.g. legacy gpt-4.1).
  if (!hasReasoning(props.backend, props.model)) return null
  const label = props.level ? THOUGHT_LABEL[props.level] : 'Auto'
  const next = THOUGHT_CYCLE[(THOUGHT_CYCLE.indexOf(props.level) + 1) % THOUGHT_CYCLE.length]
  return (
    <button
      className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.75rem] transition-colors ${props.level ? 'bg-tag text-foreground font-medium' : 'text-foreground-subtle hover:text-foreground'}`}
      onClick={() => props.onLevel(next)}
      title={`Reasoning effort — click to cycle. Current: ${props.level ? THOUGHT_LABEL[props.level] : 'auto (provider default)'}.`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6" /><path d="M10 22h4" /><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" /></svg>
      {label}
    </button>
  )
}

function PlanCard(props: { text: string; latest: boolean; busy: boolean; onApprove: (text: string) => void }): React.JSX.Element {
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-medium uppercase tracking-wide text-foreground-subtlest">proposed plan</span>
        <span className="rounded-full border border-border bg-tag px-2 py-0.5 text-[0.625rem] text-foreground-subtle">awaiting approval</span>
      </div>
      <div className="prose max-w-none text-[0.875rem] leading-relaxed text-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{props.text}</ReactMarkdown>
      </div>
      {props.latest && (
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg bg-primary px-4 py-2 text-[0.8125rem] font-semibold text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-50"
            disabled={props.busy}
            onClick={() => props.onApprove(props.text)}
          >
            Approve &amp; execute
          </button>
          <span className="text-[0.75rem] text-foreground-subtlest">or reply below to revise the plan</span>
        </div>
      )}
    </div>
  )
}

function ApprovalCard(props: { it: TranscriptItem; onDecide: (id: string, ok: boolean, scope?: 'once' | 'session' | 'project') => void }): React.JSX.Element {
  const { it } = props
  const detail = it.name === 'run_bash' ? String(it.input?.command ?? '') : String(it.input?.path ?? '')
  const decided = it.status === 'done'
  return (
    <div className={`flex w-full flex-col gap-2.5 rounded-xl border p-4 ${decided ? 'border-border bg-card opacity-70' : 'border-border bg-popover'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-medium uppercase tracking-wide text-foreground-subtlest">approval needed</span>
        {decided && <span className={`text-[0.6875rem] ${it.summary === 'allowed' ? 'text-foreground' : 'text-destructive'}`}>{it.summary}</span>}
      </div>
      <div className="flex items-center gap-2 text-[0.8125rem]">
        <span className="font-mono font-medium text-foreground">{it.name}</span>
        {it.capability && <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase text-foreground-subtlest">{it.capability}</span>}
        <span className="truncate font-mono text-[0.75rem] text-foreground-subtle">{detail}</span>
      </div>
      {!decided && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="rounded-lg bg-primary px-3.5 py-1.5 text-[0.8125rem] font-semibold text-primary-foreground shadow-sm transition-[filter] hover:brightness-110" onClick={() => props.onDecide(it.id!, true, 'once')}>Allow once</button>
          {it.capability && it.target && (
            <>
              <button className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-surface-hover" onClick={() => props.onDecide(it.id!, true, 'session')} title="Auto-allow this for the rest of this app session">This session</button>
              <button className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-surface-hover" onClick={() => props.onDecide(it.id!, true, 'project')} title={`Write an allow rule to .grasp/permissions.json — ${it.capability}(${it.target})`}>Always (project)</button>
            </>
          )}
          <button className="rounded-lg border border-border bg-secondary px-3.5 py-1.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-surface-hover" onClick={() => props.onDecide(it.id!, false)}>Deny</button>
        </div>
      )}
    </div>
  )
}

function ElicitationCard(props: { it: TranscriptItem; onDecide?: (id: string, answer: string | null) => void }): React.JSX.Element | null {
  const e = props.it.elicit
  const [sel, setSel] = useState(-1)
  const [custom, setCustom] = useState('')
  if (!e) return null
  const resolved = props.it.elicitAnswer !== undefined
  const choose = (ans: string | null): void => { if (!resolved && props.onDecide) props.onDecide(e.id, ans) }
  const submit = (): void => {
    if (sel >= 0) choose(e.options[sel].label)
    else if (custom.trim()) choose(custom.trim())
  }
  return (
    <div className={`flex w-full flex-col gap-3 rounded-xl border p-4 ${resolved ? 'border-border bg-card opacity-80' : 'border-border bg-popover'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-medium uppercase tracking-wide text-foreground-subtlest">{e.header ?? 'question'}</span>
        {resolved && <span className="text-[0.6875rem] text-foreground-subtle">→ {props.it.elicitAnswer === null ? '(dismissed)' : props.it.elicitAnswer}</span>}
      </div>
      <div className="text-[0.8125rem] text-foreground">{e.question}</div>
      {!resolved && (
        <>
          <div className="flex flex-col gap-1.5">
            {e.options.map((o, i) => (
              <button key={i} type="button" onClick={() => setSel(i)} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[0.8125rem] transition-colors ${sel === i ? 'border-foreground bg-surface' : 'border-border hover:bg-surface-hover'}`}>
                <span className={`mt-0.5 size-3.5 shrink-0 rounded-full border ${sel === i ? 'border-foreground bg-foreground' : 'border-foreground-subtlest'}`} />
                <span className="flex flex-col"><span className="text-foreground">{o.label}</span>{o.description && <span className="text-[0.75rem] text-foreground-subtle">{o.description}</span>}</span>
              </button>
            ))}
          </div>
          <input value={custom} onChange={(ev) => setCustom(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') submit() }} placeholder="Or type your own answer…" className="rounded-lg border border-border bg-input px-3 py-2 text-[0.8125rem] text-foreground outline-none focus:border-foreground" />
          <div className="flex items-center gap-2">
            <button className="rounded-lg bg-primary px-3.5 py-1.5 text-[0.8125rem] font-semibold text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-40" onClick={submit} disabled={sel < 0 && !custom.trim()}>Continue</button>
            <button className="rounded-lg border border-border bg-secondary px-3.5 py-1.5 text-[0.8125rem] font-medium text-foreground transition-[filter] hover:brightness-110" onClick={() => choose(null)}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  )
}

function AppLauncher({ workspace }: { workspace: string }): React.JSX.Element {
  const [appsOpen, setAppsOpen] = useState(false)
  const [apps, setApps] = useState<{ id: string; name: string; icon: string }[]>([])
  const [lastApp, setLastApp] = useState<string>(() => localStorage.getItem('grasp-last-app') ?? '')
  // Detect on open AND once on mount, so the trigger shows the last editor's icon immediately
  useEffect(() => { void window.grasp.detectApps().then(setApps) }, [])
  useEffect(() => { if (appsOpen) void window.grasp.detectApps().then(setApps) }, [appsOpen])
  const lastAppObj = apps.find((a) => a.id === lastApp) ?? apps[0] ?? null
  const openLast = (): void => {
    if (lastAppObj) void window.grasp.openInApp(lastAppObj.id, workspace)
    else setAppsOpen(true)
  }
  const pick = (id: string): void => {
    setLastApp(id)
    localStorage.setItem('grasp-last-app', id)
    void window.grasp.openInApp(id, workspace)
    setAppsOpen(false)
  }
  // ZCode-style split button: primary "Open" (launches in the last editor) + caret (picker)
  return (
    <div className="relative flex items-stretch" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        className="flex items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-card pl-2 pr-1.5 py-1 text-[0.75rem] text-foreground-subtle shadow-sm transition-colors hover:bg-surface-hover"
        onClick={openLast}
        title={lastAppObj ? `Open in ${lastAppObj.name}` : 'Open in external editor'}
      >
        {lastAppObj ? <EditorIcon id={lastAppObj.id} size={15} /> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 17l6-6 4 4 8-8M14 7h7v7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        <span>{lastAppObj ? 'Open' : 'Open in…'}</span>
      </button>
      <button
        className="flex items-center rounded-r-lg border border-border bg-card px-1 py-1 text-foreground-subtlest shadow-sm transition-colors hover:bg-surface-hover"
        onClick={() => setAppsOpen((o) => !o)}
        title="Choose editor"
      >
        <svg width="9" height="9" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {appsOpen && (
        <>
          {/* click-away layer */}
          <div className="fixed inset-0 z-40" onClick={() => setAppsOpen(false)} />
          <div className="absolute top-full left-0 z-50 mt-1 flex w-[208px] flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-2xl">
            <button
              className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-surface-hover"
              onClick={() => { if (lastAppObj) pick(lastAppObj.id); else setAppsOpen(false) }}
            >
              {lastAppObj ? <EditorIcon id={lastAppObj.id} size={16} /> : <span className="w-4" />}
              <span className="flex-1 text-left">Open</span>
            </button>
            <div className="my-0.5 h-px bg-border" />
            {apps.map((app) => (
              <button
                key={app.id}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[0.8125rem] transition-colors ${app.id === lastApp ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`}
                onClick={() => pick(app.id)}
              >
                <EditorIcon id={app.id} size={16} />
                <span className="flex-1 text-left">{app.name}</span>
                {app.id === lastApp && <span className="text-foreground-subtlest">✓</span>}
              </button>
            ))}
            {apps.length === 0 && <div className="px-2.5 py-2 text-[0.75rem] text-foreground-subtlest">No editors detected.</div>}
          </div>
        </>
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
  mode: 'auto' | 'ask' | 'plan' | 'task'
  tokens: number
  budget: string
  onBudget: (v: string) => void
  onCompact?: () => void
  onCheck?: () => void
  onForkUser?: (index: number) => void
  onRevertUser?: (index: number) => void
  onLoadRepo?: () => void
  resume?: { label: string; onResume: () => void }
  flowStatus?: FlowStatus
  onBackend: (id: string) => void
  onModel: (m: string) => void
  thoughtLevel?: ThoughtLevel
  onThoughtLevel?: (l: ThoughtLevel | undefined) => void
  onMode: (m: 'auto' | 'ask' | 'plan' | 'task') => void
  onApprovePlan: (text: string) => void
  onDecideApproval: (id: string, ok: boolean, scope?: 'once' | 'session' | 'project') => void
  onDecideElicitation?: (id: string, answer: string | null) => void
  onSend: (prompt: string) => void
  draft?: string
  onDraft?: (v: string) => void
  sessionTitle?: string
  onDismissError?: () => void
  onStop: () => void
  onQueue?: (prompt: string) => void // while busy: queue a follow-up for after the turn
  onSteer?: (prompt: string) => void // while busy: inject into the in-flight turn now
  queue?: string[]
  onRemoveQueued?: (index: number) => void
  onRegenerate?: () => void
  onReact?: (index: number, reaction: 'up' | 'down' | undefined) => void
  onToggleTerminal?: () => void
  onToggleSidebar?: () => void
  banner?: React.ReactNode
  commands: SlashCommand[]
  skills: { name: string; description: string }[]
  workspace?: string
}): React.JSX.Element {
  const [localInput, setLocalInput] = useState('')
  const input = props.draft ?? localInput
  const setInput = props.onDraft ?? setLocalInput
  const [armRevert, setArmRevert] = useState<number | null>(null) // two-click revert confirm
  const [slashIx, setSlashIx] = useState(0)
  const [enhancing, setEnhancing] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  useEffect(() => {
    const el = logRef.current
    if (el && stickBottom.current) el.scrollTo({ top: el.scrollHeight })
  }, [props.transcript, props.busy])

  function onLogScroll(): void {
    const el = logRef.current
    if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  function submit(): void {
    const t = input.trim()
    if (!t) return
    // While the agent runs, Enter queues a follow-up (sent when the turn ends)
    // instead of dropping the input. Use the ⚡ Steer button to inject now.
    if (props.busy && props.onQueue) {
      props.onQueue(t)
      setInput('')
      return
    }
    if (typedCmd && t.startsWith('/')) {
      // Never send a raw template: a command that needs arguments does not submit
      // without them (the hint row explains), and $ARGUMENTS/$N are substituted here.
      if (typedCmd.hasArgs && !typedCmd.args) return
      stickBottom.current = true
      props.onSend(expandCommand(typedCmd.cmd, typedCmd.args))
      setInput('')
      setSlashIx(0)
      return
    }
    stickBottom.current = true
    props.onSend(t)
    setInput('')
  }

  function steer(): void {
    const t = input.trim()
    if (!t || !props.onSteer) return
    props.onSteer(t)
    setInput('')
  }

  // Enhance: one-shot rewrite of the current prompt for clarity (no agent loop).
  async function enhance(): Promise<void> {
    const t = input.trim()
    if (!t || enhancing || props.busy) return
    setEnhancing(true)
    const sys = "Rewrite the prompt to a coding agent to be clearer, more specific, and more actionable, preserving the user's intent and any names/paths/commands. Reply with ONLY the rewritten prompt — no preamble, no quotes."
    const res = await window.grasp.oneShot({ backend: props.backend, model: props.model, system: sys, user: t, maxTokens: 512 })
    setEnhancing(false)
    if (res.ok && res.text) setInput(res.text.trim())
  }

  const slashQuery = input.startsWith('/') && !input.slice(1).includes(' ') ? input.slice(1).toLowerCase() : null
  const slashItems = slashQuery === null ? [] : [
    ...props.commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).map((c) => ({
      kind: 'command' as const, name: c.name, desc: c.description || (c.skills ? `skill: ${c.skills}` : ''),
      body: c.body, hasArgs: /\$ARGUMENTS|\$\d/.test(c.body), skill: c.skills
    })),
    ...props.skills.filter((s) => s.name.toLowerCase().includes(slashQuery)).map((s) => ({ kind: 'skill' as const, name: s.name, desc: s.description }))
  ].slice(0, 8)
  const slashCur = slashItems.length ? Math.min(slashIx, slashItems.length - 1) : -1

  // A typed command ("/flow src/x.ts:fn") closes the menu at the first space; from there the
  // command expands at submit time. Templates with $ARGUMENTS/$N never reach the agent raw.
  const typedCmd = (() => {
    const m = /^\/([\w-]+)(\s+([\s\S]*))?$/.exec(input)
    if (!m) return null
    const cmd = props.commands.find((c) => c.name === m[1])
    if (!cmd) return null
    return { cmd, args: (m[3] ?? '').trim(), hasArgs: /\$ARGUMENTS|\$\d/.test(cmd.body) }
  })()

  function expandCommand(c: { body: string; skills?: string }, args: string): string {
    const words = args ? args.split(/\s+/) : []
    const body = c.body
      .replace(/\$ARGUMENTS/g, args)
      .replace(/\$(\d)/g, (_s, d: string) => words[Number(d) - 1] ?? '')
      .replace(/ {2,}/g, ' ')
      .trim()
    return c.skills ? `Use the "${c.skills}" skill, then follow these instructions:\n\n${body}` : body
  }

  function sendBody(b: string): void {
    if (props.busy) return
    stickBottom.current = true
    props.onSend(b)
    setInput('')
    setSlashIx(0)
  }
  function pickSlash(item: (typeof slashItems)[number]): void {
    if (item.kind === 'skill') { sendBody(`Use the "${item.name}" skill.`); return }
    // Needs arguments -> stay in slash form and wait for them (expansion happens at submit);
    // no arguments -> expand and send immediately.
    if (item.hasArgs) { setInput('/' + item.name + ' '); return }
    const prefix = item.skill ? `Use the "${item.skill}" skill, then follow these instructions:\n\n` : ''
    sendBody(prefix + item.body.replace(/\$ARGUMENTS/g, '').replace(/\$\d+/g, '').replace(/ {2,}/g, ' ').trim())
  }

  const activeLabel = props.backends.find((b) => b.id === props.backend)?.label ?? props.backend
  const cw = lookupModel(props.backend, props.model)?.contextWindow
  const ctxPct = cw ? Math.min(100, Math.round((props.tokens / cw) * 100)) : null
  const top = props.transcript.filter((it) => !it.parent)

  const renderItem = (it: TranscriptItem, i: number, isLast = false): React.JSX.Element => {
    if (it.role === 'plan') return <PlanCard key={i} text={it.text ?? ''} latest={isLast} busy={props.busy} onApprove={props.onApprovePlan} />
    if (it.role === 'hook') {
      const h = it.hook
      return (
        <div key={i} className="flex w-full justify-center">
          <span className="max-w-full truncate rounded-md border border-border bg-surface px-2 py-0.5 text-[0.6875rem] font-mono text-foreground-subtle" title={h?.output}>
            <span className="text-foreground-subtlest">hook {h?.event}{h?.tool ? ` · ${h.tool}` : ''}:</span> {h?.output}
          </span>
        </div>
      )
    }
    if (it.role === 'approval') return <ApprovalCard key={it.id ?? i} it={it} onDecide={props.onDecideApproval} />
    if (it.role === 'elicitation') return <ElicitationCard key={it.elicit?.id ?? i} it={it} onDecide={props.onDecideElicitation} />
    if (it.role === 'tool') {
      const kids = it.id ? props.transcript.filter((k) => k.parent === it.id) : []
      const chip = <ToolBlock key={it.id ?? i} it={it} />
      if ((it.name === 'task' || it.name === 'Task') && kids.length > 0)
        return (
          <div key={it.id ?? i} className="flex w-full flex-col">
            {chip}
            <div className="ml-3.5 flex flex-col gap-2.5 border-l-2 border-border-hover pl-3.5">{kids.map((k, ki) => renderItem(k, ki))}</div>
          </div>
        )
      return chip
    }
    if (it.role === 'user')
      return (
        <div key={i} className="group/msguser flex w-full flex-col items-end gap-1">
          <div className="flex max-w-[576px] flex-col rounded-xl rounded-tr-sm border border-border bg-surface px-4 py-3 text-[0.875rem] leading-relaxed text-foreground">
            {it.text}
          </div>
          <span className="flex items-center gap-1">
            {props.onForkUser && it.histLen !== undefined && (
              <button className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] text-foreground-subtlest opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground-subtle group-hover/msguser:opacity-100" onClick={() => props.onForkUser?.(i)} title="Fork from here — branch the conversation at your message">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 3v6a3 3 0 0 0 3 3h6M18 21v-6a3 3 0 0 0-3-3H9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="6" cy="3" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="21" r="2.4" stroke="currentColor" strokeWidth="1.7" /></svg>
                Fork
              </button>
            )}
            {props.onRevertUser && it.checkpointSha && (
              <button
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] transition-opacity group-hover/msguser:opacity-100 ${armRevert === i ? 'bg-destructive/15 text-destructive opacity-100' : 'text-foreground-subtlest opacity-0 hover:bg-surface-hover hover:text-foreground-subtle'}`}
                onClick={() => {
                  if (armRevert === i) {
                    setArmRevert(null)
                    props.onRevertUser?.(i)
                  } else setArmRevert(i)
                }}
                onMouseLeave={() => setArmRevert((a) => (a === i ? null : a))}
                title="Revert — reset the workspace files to the state before this step and rewind the chat (a recovery checkpoint is committed first)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {armRevert === i ? 'reset files + chat — sure?' : 'Revert'}
              </button>
            )}
          </span>
        </div>
      )
    return (
      <div key={i} className="group/msg flex w-full flex-col gap-2">
        {/* Thinking / reasoning collapsible (model trajectory) */}
        {(it.thinking || it.thinkingStreaming) && (
          <details className="rounded-lg border border-border bg-surface">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.75rem] text-foreground-subtlest transition-colors hover:text-foreground-subtle">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 9.5 2zM7.5 15.5l2-3 2 3M16.5 12a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {it.thinkingStreaming ? <span className="animate-pulse text-foreground-subtle">Thinking…</span> : <span>Thought{it.thinkingMs ? ` for ${(it.thinkingMs / 1000).toFixed(1)}s` : ''}</span>}
            </summary>
            <div className="border-t border-border px-3 py-2 text-[0.75rem] leading-relaxed text-foreground-subtlest">
              {it.thinking || '…'}
            </div>
          </details>
        )}
        <div className="prose max-w-none text-[0.875rem] leading-relaxed text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{it.text ?? ''}</ReactMarkdown>
        </div>
        {/* Hover actions: copy + regenerate + reactions */}
        {!it.streaming && it.text && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
            <button
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
              onClick={() => { void navigator.clipboard.writeText(it.text ?? ''); }}
              title="Copy message"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.7" /></svg>
              Copy
            </button>
            {props.onRegenerate && (
              <button
                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
                onClick={() => props.onRegenerate?.()}
                title="Regenerate response"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3M21 4v4h-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Retry
              </button>
            )}
            {props.onReact && (
              <>
                <button
                  className={`ml-1 rounded-md p-1 text-[0.6875rem] transition-colors ${it.reaction === 'up' ? 'text-foreground' : 'text-foreground-subtlest hover:text-foreground-subtle'}`}
                  onClick={() => props.onReact?.(i, it.reaction === 'up' ? undefined : 'up')}
                  title="Good response"
                >👍</button>
                <button
                  className={`rounded-md p-1 text-[0.6875rem] transition-colors ${it.reaction === 'down' ? 'text-destructive' : 'text-foreground-subtlest hover:text-foreground-subtle'}`}
                  onClick={() => props.onReact?.(i, it.reaction === 'down' ? undefined : 'down')}
                  title="Bad response"
                >👎</button>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="@container flex h-full min-w-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border bg-background px-5 py-3" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        {props.onToggleSidebar && (
          <button
            className="border-0 bg-transparent text-foreground-subtlest transition-colors hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={props.onToggleSidebar}
            title="Toggle sidebar (⌘B)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM9 5v14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        <span className="min-w-0 truncate whitespace-nowrap text-[0.875rem] font-medium text-foreground" title={props.sessionTitle || undefined}>{props.sessionTitle?.trim() || 'New session'}</span>
        {/* External app launcher */}
        {props.workspace && (
          <span className="hidden shrink-0 @[480px]:block">
            <AppLauncher workspace={props.workspace} />
          </span>
        )}
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[0.6875rem] text-foreground-subtle shadow-sm @[560px]:inline-flex" title="tokens used this session">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".4" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          {fmtTokens(props.tokens)}
          {ctxPct !== null && (
            <span className="ml-1 h-1 w-10 overflow-hidden rounded-full bg-border" title={`${ctxPct}% of ~${Math.round((cw ?? 0) / 1000)}k context window`}>
              <span className="block h-full rounded-full" style={{ width: `${ctxPct}%`, background: ctxPct > 80 ? 'var(--color-destructive)' : ctxPct > 50 ? 'var(--color-warning)' : 'var(--color-accent-blue)' }} />
            </span>
          )}
          <span className="font-sans text-[0.625rem] uppercase tracking-wide text-foreground-subtlest">budget</span>
          <input
            className="w-[46px] border-0 bg-transparent text-right font-mono text-[0.6875rem] text-foreground outline-none"
            value={props.budget}
            onChange={(e) => props.onBudget(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="none"
            spellCheck={false}
          />
        </span>
        {props.onCompact && (
          <button type="button" onClick={props.onCompact} disabled={props.busy || props.tokens < 1000} className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40" title="Compact context — summarize the conversation so far">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 9h4V4M20 9h-4V4M4 15h4v5M20 15h-4v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        {props.onCheck && (
          <button type="button" onClick={props.onCheck} disabled={props.busy} className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40" title="Lifeguard — check uncommitted changes for concerns">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        {(() => {
          const fs = props.flowStatus
          if (!fs || fs === 'idle') return null
          const map: Record<string, { label: string; cls: string }> = {
            planning: { label: 'Planning', cls: 'bg-warning/20 text-warning' },
            'awaiting-approval': { label: 'Review plan', cls: 'bg-accent-blue/20 text-foreground animate-pulse' },
            executing: { label: 'Executing', cls: 'bg-success/20 text-success animate-pulse' },
            done: { label: 'Done', cls: 'bg-tag text-foreground-subtle' },
            failed: { label: 'Failed', cls: 'bg-destructive/20 text-destructive' }
          }
          const m = map[fs] ?? { label: fs, cls: 'bg-tag text-foreground-subtle' }
          return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${m.cls}`} title={`Flow: ${fs}`}>{m.label}</span>
        })()}
        <span className="ml-auto inline-flex max-w-[190px] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-1 text-[0.75rem] text-foreground-subtle shadow-sm @[560px]:ml-0" title={`${activeLabel} · ${props.model}`}>
          <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
          <span className="min-w-0 truncate">{activeLabel} · {props.model}</span>
        </span>
      </header>

      {props.banner}

      {/* Transcript */}
      <div className="grasp-transcript flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5" ref={logRef} onScroll={onLogScroll} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {props.transcript.length === 0 && (
          <div className="m-auto flex max-w-[400px] flex-col items-center gap-2.5 px-5 py-10 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-surface text-foreground-subtlest">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" /><path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.7" /></svg>
            </div>
            <h2 className="text-[1.25rem] font-semibold tracking-tight text-foreground">What should we change?</h2>
            <p className="text-[0.8125rem] leading-relaxed text-foreground-subtle">Ask an agent to edit code. Type <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.75rem] text-foreground">/</code> for commands, <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.75rem] text-foreground">$</code> for skills.</p>
            <p className="text-[0.75rem] text-foreground-subtlest">The observed dataflow shows on the right — you adjudicate what the change did.</p>
            {props.onLoadRepo && (
              <button
                className="mt-1.5 rounded-lg border border-border bg-card px-3.5 py-1.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-surface-hover"
                onClick={props.onLoadRepo}
                title="The agent introduces this workspace: how it runs, the flows you can ask to see, the rules awaiting your signature"
              >
                Load repo
              </button>
            )}
            {props.resume && (
              <button
                className="rounded-lg px-3.5 py-1 text-[0.8125rem] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
                onClick={props.resume.onResume}
                title="Open your most recent conversation"
              >
                Resume last — {props.resume.label}
              </button>
            )}
          </div>
        )}
        {top.map((it, i) => renderItem(it, i, i === top.length - 1))}
        {props.busy && !props.transcript.some((it) => it.streaming) && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="size-1.5 animate-pulse rounded-full bg-foreground-subtlest" />
            <span className="size-1.5 animate-pulse rounded-full bg-foreground-subtlest" style={{ animationDelay: '0.18s' }} />
            <span className="size-1.5 animate-pulse rounded-full bg-foreground-subtlest" style={{ animationDelay: '0.36s' }} />
          </div>
        )}

      </div>

      {props.error && (
        <div className="mx-5 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="min-w-0 flex-1">{props.error}</span>
          {props.onDismissError && (
            <button className="shrink-0 rounded p-0.5 text-destructive/70 transition-colors hover:text-destructive" title="Dismiss" onClick={props.onDismissError}>✕</button>
          )}
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 px-5 pb-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="relative flex flex-col gap-3 rounded-2xl border border-border bg-input p-3 transition-colors focus-within:border-border-hover focus-within:shadow-[0_0_0_1px_var(--color-border-hover)]">
          {slashItems.length === 0 && typedCmd && typedCmd.hasArgs && !typedCmd.args && (
            <div className="absolute bottom-full left-0 right-0 z-20 mb-1.5 rounded-xl border border-border bg-popover px-3 py-2 text-[0.75rem] text-foreground-subtle shadow-2xl">
              <span className="font-semibold text-foreground">/{typedCmd.cmd.name}</span> needs a target — a feature or a function, then Enter (e.g. \u201cshare-link encoding\u201d or src/file.ts:fn). {typedCmd.cmd.description}
            </div>
          )}
          {slashItems.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-[260px] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-2xl">
              {slashItems.map((it, i) => (
                <button
                  key={it.kind + '|' + it.name}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors ${i === slashCur ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`}
                  onMouseEnter={() => setSlashIx(i)}
                  onClick={() => pickSlash(it)}
                >
                  <span className="shrink-0 font-semibold text-foreground">{it.kind === 'command' ? '/' + it.name : it.name}</span>
                  <span className="flex-1 truncate text-[0.75rem]">{it.desc.slice(0, 56)}</span>
                  <span className="shrink-0 rounded-full border border-border px-1.5 text-[0.625rem] uppercase text-foreground-subtlest">{it.kind}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            className="w-full max-h-[180px] resize-none border-0 bg-transparent text-[0.875rem] leading-relaxed text-foreground outline-none placeholder:text-foreground-subtlest"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (slashItems.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIx((i) => (i + 1) % slashItems.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIx((i) => (i - 1 + slashItems.length) % slashItems.length); return }
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pickSlash(slashItems[slashCur]); return }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); submit() }
            }}
            placeholder={props.busy ? 'Queue a follow-up (Enter) — or ⚡ Steer to inject now' : 'Ask an agent to change code…  (type / for commands)'}
            rows={2}
            autoFocus
          />
          {props.queue && props.queue.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {props.queue.map((q, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[0.6875rem] text-foreground-subtle" title={`Queued: ${q}`}>
                  <span className="max-w-[240px] truncate">⏳ {q}</span>
                  {props.onRemoveQueued && <button type="button" className="text-foreground-subtlest hover:text-foreground" onClick={() => props.onRemoveQueued?.(i)}>✕</button>}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
            <ModelPicker backends={props.backends} backend={props.backend} model={props.model} onBackend={props.onBackend} onModel={props.onModel} />
            {props.onThoughtLevel && (
              <ThoughtLevelPicker backend={props.backend} model={props.model} level={props.thoughtLevel} onLevel={props.onThoughtLevel} />
            )}
            <span className="flex shrink-0 items-center rounded-lg bg-tag p-0.5 text-[0.75rem]" title="Build: edit directly. Ask: approve each edit. Plan: propose first.">
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'auto' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('auto')}>Build</button>
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'ask' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('ask')}>Ask</button>
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'plan' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('plan')}>Plan</button>
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'task' ? 'bg-accent-blue text-white font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('task')} title="Task: run the full loop — plan → approve → implement → verify (tests) → review">Task</button>
            </span>
            <button type="button" onClick={enhance} disabled={!input.trim() || enhancing || props.busy} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[0.75rem] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40" title="Enhance prompt — rewrite for clarity">
              {enhancing
                ? <span className="size-3 animate-spin rounded-full border-[1.5px] border-foreground-subtle border-r-transparent" />
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>}
              Enhance
            </button>
            {props.onToggleTerminal && (
              <button
                className="flex size-[30px] items-center justify-center rounded-lg border border-border text-foreground-subtle transition-colors hover:border-border-hover hover:text-foreground"
                onClick={props.onToggleTerminal}
                title="Toggle terminal"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
            {props.busy ? (
              <div className="flex items-center gap-1.5">
                {props.onSteer && (
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded-lg bg-tag text-foreground-subtle transition-[filter] hover:brightness-110 disabled:opacity-40"
                    onClick={steer}
                    disabled={!input.trim()}
                    title="Steer — inject into the running turn now"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" /></svg>
                  </button>
                )}
                <button
                  className="flex size-8 items-center justify-center rounded-lg bg-secondary text-foreground transition-[filter] hover:brightness-110"
                  onClick={props.onStop}
                  title="Stop the agent (Esc)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
                </button>
              </div>
            ) : (
              <button
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-[filter] hover:brightness-110"
                onClick={submit}
                title="Send (Enter · Shift+Enter for newline)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
