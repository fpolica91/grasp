// The conversation: product-grade message rendering. Markdown with real syntax-highlighted
// code blocks (copy + collapse), subtle inline code, and TOOL CALLS as clean collapsible
// blocks. Plus plan cards, approval cards, nested subagents, a working provider/model picker,
// a token meter, and a slash-command menu. Fully migrated to Tailwind v4.
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { EditorIcon } from './editor-icons'
import type { BackendInfo, SlashCommand } from '../../../shared/types'

export interface TranscriptItem {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'plan' | 'approval'
  text?: string
  thinking?: string
  thinkingMs?: number
  thinkingStreaming?: boolean
  name?: string
  input?: Record<string, unknown>
  summary?: string
  output?: string
  status?: 'running' | 'done'
  parent?: string
  streaming?: boolean
  reaction?: 'up' | 'down'
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
        <span className="text-[11px] font-medium text-foreground-subtlest">{lang || 'text'}</span>
        <button className="text-[11px] text-foreground-subtlest transition-colors hover:text-foreground-subtle" onClick={copy}>
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre className={`overflow-auto p-4 font-mono text-[13px] leading-relaxed text-foreground ${collapsed ? 'max-h-[60px]' : ''}`}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {lineCount > 24 && (
        <button className="w-full border-t border-border py-1 text-center text-[11px] text-foreground-subtlest transition-colors hover:text-foreground-subtle" onClick={() => setCollapsed((c) => !c)}>
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
    return <code className="rounded bg-tag px-1 py-0.5 font-mono text-[12px]">{children}</code>
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
        className="inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-[13px] outline-none"
        onClick={() => setOpen((o) => !o)}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
      >
        <span className={`text-[9px] transition-transform ${open ? 'rotate-90' : ''} text-foreground-subtlest opacity-0 group-hover/tool:opacity-100 ${open ? 'opacity-100' : ''}`}>▸</span>
        <span className={`shrink-0 font-medium whitespace-nowrap ${running ? 'text-foreground' : 'text-foreground-subtlest'}`}>{verb}</span>
        <span className="truncate font-mono text-[12px] text-foreground">{arg}</span>
        {running && (
          <span className="ml-1 size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-foreground border-r-transparent" />
        )}
      </div>
      {open && (
        <div className="mt-1.5 rounded-xl border border-border bg-panel px-4 py-3">
          {cmd && <CodeBlock lang="bash" code={cmd} />}
          {inputDetail && <CodeBlock lang="json" code={inputDetail} />}
          {it.output ? (
            <pre className="mt-2 max-h-[100px] overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] text-foreground-subtle">{it.output}</pre>
          ) : (
            <p className="font-mono text-[13px] text-foreground-subtle">{running ? 'running…' : 'no captured output for this call'}</p>
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
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-foreground-subtle">
      <span className={`size-1.5 rounded-full ${active?.ok ? 'bg-foreground' : 'bg-foreground-subtlest'}`} title={active?.ok ? 'available' : (active?.reason ?? 'unavailable')} />
      <select
        className="border-0 bg-transparent text-[12px] text-foreground-subtle outline-none"
        value={props.backend}
        onChange={(e) => props.onBackend(e.target.value)}
        title="agent backend"
      >
        {props.backends.map((b) => (<option key={b.id} value={b.id}>{b.label}</option>))}
      </select>
      <span className="text-foreground-subtlest">/</span>
      <select
        className="border-0 bg-transparent text-[12px] text-foreground-subtle outline-none"
        value={props.model}
        onChange={(e) => props.onModel(e.target.value)}
        title="model"
      >
        {(active?.models ?? []).map((m) => (<option key={m} value={m}>{m}</option>))}
      </select>
    </span>
  )
}

function PlanCard(props: { text: string; latest: boolean; busy: boolean; onApprove: (text: string) => void }): React.JSX.Element {
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtlest">proposed plan</span>
        <span className="rounded-full border border-border bg-tag px-2 py-0.5 text-[10px] text-foreground-subtle">awaiting approval</span>
      </div>
      <div className="prose max-w-none text-[13px] leading-relaxed text-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{props.text}</ReactMarkdown>
      </div>
      {props.latest && (
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110 disabled:opacity-50"
            disabled={props.busy}
            onClick={() => props.onApprove(props.text)}
          >
            Approve &amp; execute
          </button>
          <span className="text-[12px] text-foreground-subtlest">or reply below to revise the plan</span>
        </div>
      )}
    </div>
  )
}

function ApprovalCard(props: { it: TranscriptItem; onDecide: (id: string, ok: boolean) => void }): React.JSX.Element {
  const { it } = props
  const detail = it.name === 'run_bash' ? String(it.input?.command ?? '') : String(it.input?.path ?? '')
  const decided = it.status === 'done'
  return (
    <div className={`flex w-full flex-col gap-2.5 rounded-xl border p-4 ${decided ? 'border-border bg-card opacity-70' : 'border-border bg-popover'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtlest">approval needed</span>
        {decided && <span className={`text-[11px] ${it.summary === 'allowed' ? 'text-foreground' : 'text-destructive'}`}>{it.summary}</span>}
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-mono font-medium text-foreground">{it.name}</span>
        <span className="truncate font-mono text-[12px] text-foreground-subtle">{detail}</span>
      </div>
      {!decided && (
        <div className="flex items-center gap-2">
          <button className="rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110" onClick={() => props.onDecide(it.id!, true)}>Allow</button>
          <button className="rounded-lg border border-border bg-secondary px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-filter hover:brightness-110" onClick={() => props.onDecide(it.id!, false)}>Deny</button>
        </div>
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
        className="flex items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-card pl-2 pr-1.5 py-1 text-[12px] text-foreground-subtle shadow-sm transition-colors hover:bg-surface-hover"
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
              className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-hover"
              onClick={() => { if (lastAppObj) pick(lastAppObj.id); else setAppsOpen(false) }}
            >
              {lastAppObj ? <EditorIcon id={lastAppObj.id} size={16} /> : <span className="w-4" />}
              <span className="flex-1 text-left">Open</span>
            </button>
            <div className="my-0.5 h-px bg-border" />
            {apps.map((app) => (
              <button
                key={app.id}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${app.id === lastApp ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`}
                onClick={() => pick(app.id)}
              >
                <EditorIcon id={app.id} size={16} />
                <span className="flex-1 text-left">{app.name}</span>
                {app.id === lastApp && <span className="text-foreground-subtlest">✓</span>}
              </button>
            ))}
            {apps.length === 0 && <div className="px-2.5 py-2 text-[12px] text-foreground-subtlest">No editors detected.</div>}
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
  mode: 'auto' | 'ask' | 'plan'
  tokens: number
  budget: string
  onBudget: (v: string) => void
  onBackend: (id: string) => void
  onModel: (m: string) => void
  onMode: (m: 'auto' | 'ask' | 'plan') => void
  onApprovePlan: (text: string) => void
  onDecideApproval: (id: string, ok: boolean) => void
  onSend: (prompt: string) => void
  onStop: () => void
  onRegenerate?: () => void
  onReact?: (index: number, reaction: 'up' | 'down' | undefined) => void
  onToggleTerminal?: () => void
  onToggleSidebar?: () => void
  banner?: React.ReactNode
  commands: SlashCommand[]
  skills: { name: string; description: string }[]
  workspace?: string
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [slashIx, setSlashIx] = useState(0)
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
    if (!t || props.busy) return
    stickBottom.current = true
    props.onSend(t)
    setInput('')
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

  function sendBody(b: string): void {
    if (props.busy) return
    stickBottom.current = true
    props.onSend(b)
    setInput('')
    setSlashIx(0)
  }
  function pickSlash(item: (typeof slashItems)[number]): void {
    if (item.kind === 'skill') { sendBody(`Use the "${item.name}" skill.`); return }
    const prefix = item.skill ? `Use the "${item.skill}" skill, then follow these instructions:\n\n` : ''
    if (item.hasArgs) setInput(prefix + item.body)
    else sendBody(prefix + item.body.replace(/\$ARGUMENTS/g, '').replace(/\$\d+/g, '').replace(/ {2,}/g, ' ').trim())
  }

  const activeLabel = props.backends.find((b) => b.id === props.backend)?.label ?? props.backend
  const top = props.transcript.filter((it) => !it.parent)

  const renderItem = (it: TranscriptItem, i: number, isLast = false): React.JSX.Element => {
    if (it.role === 'plan') return <PlanCard key={i} text={it.text ?? ''} latest={isLast} busy={props.busy} onApprove={props.onApprovePlan} />
    if (it.role === 'approval') return <ApprovalCard key={it.id ?? i} it={it} onDecide={props.onDecideApproval} />
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
        <div key={i} className="flex w-full flex-col items-end gap-2">
          <div className="flex max-w-[576px] flex-col rounded-xl rounded-tr-sm border border-border bg-surface px-4 py-3 text-[13px] text-foreground">
            {it.text}
          </div>
        </div>
      )
    return (
      <div key={i} className="group/msg flex w-full flex-col gap-2">
        {/* Thinking / reasoning collapsible (model trajectory) */}
        {(it.thinking || it.thinkingStreaming) && (
          <details className="rounded-lg border border-border bg-surface" open={it.thinkingStreaming}>
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] text-foreground-subtlest transition-colors hover:text-foreground-subtle">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 9.5 2zM7.5 15.5l2-3 2 3M16.5 12a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {it.thinkingStreaming ? <span className="animate-pulse text-foreground-subtle">Thinking…</span> : <span>Thought{it.thinkingMs ? ` for ${(it.thinkingMs / 1000).toFixed(1)}s` : ''}</span>}
            </summary>
            <div className="border-t border-border px-3 py-2 text-[12px] leading-relaxed text-foreground-subtlest">
              {it.thinking || '…'}
            </div>
          </details>
        )}
        <div className="prose max-w-none text-[13px] leading-relaxed text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{it.text ?? ''}</ReactMarkdown>
        </div>
        {/* Hover actions: copy + regenerate + reactions */}
        {!it.streaming && it.text && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
            <button
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
              onClick={() => { void navigator.clipboard.writeText(it.text ?? ''); }}
              title="Copy message"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.7" /></svg>
              Copy
            </button>
            {props.onRegenerate && (
              <button
                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
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
                  className={`ml-1 rounded-md p-1 text-[11px] transition-colors ${it.reaction === 'up' ? 'text-foreground' : 'text-foreground-subtlest hover:text-foreground-subtle'}`}
                  onClick={() => props.onReact?.(i, it.reaction === 'up' ? undefined : 'up')}
                  title="Good response"
                >👍</button>
                <button
                  className={`rounded-md p-1 text-[11px] transition-colors ${it.reaction === 'down' ? 'text-destructive' : 'text-foreground-subtlest hover:text-foreground-subtle'}`}
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
    <section className="flex h-full min-w-0 flex-col">
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
        <span className="text-[14px] font-medium text-foreground">Session<span className="ml-2 text-[12px] font-normal text-foreground-subtlest">post-editor</span></span>
        {/* External app launcher */}
        {props.workspace && <AppLauncher workspace={props.workspace} />}
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground-subtle shadow-sm" title="tokens used this session">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".4" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          {fmtTokens(props.tokens)}
          <span className="font-sans text-[10px] uppercase tracking-wide text-foreground-subtlest">budget</span>
          <input
            className="w-[46px] border-0 bg-transparent text-right font-mono text-[11px] text-foreground outline-none"
            value={props.budget}
            onChange={(e) => props.onBudget(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="none"
            spellCheck={false}
          />
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[12px] text-foreground-subtle shadow-sm">
          <span className="size-1.5 rounded-full bg-foreground" />
          {activeLabel} · {props.model}
        </span>
      </header>

      {props.banner}

      {/* Transcript */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5" ref={logRef} onScroll={onLogScroll} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {props.transcript.length === 0 && (
          <div className="m-auto flex max-w-[400px] flex-col items-center gap-2.5 px-5 py-10 text-center">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-surface text-foreground-subtlest">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" /><path d="M8 7l8 4M8 17l8-4" stroke="currentColor" strokeWidth="1.7" /></svg>
            </div>
            <h2 className="text-[20px] font-semibold tracking-tight text-foreground">What should we change?</h2>
            <p className="text-[13px] leading-relaxed text-foreground-subtle">Ask an agent to edit code. Type <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px] text-foreground">/</code> for commands, <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px] text-foreground">$</code> for skills.</p>
            <p className="text-[12px] text-foreground-subtlest">The observed dataflow shows on the right — you adjudicate what the change did.</p>
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
        {props.error && <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-destructive">{props.error}</div>}
      </div>

      {/* Composer */}
      <div className="shrink-0 px-5 pb-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="relative flex flex-col gap-3 rounded-2xl border border-border bg-input p-3 transition-colors focus-within:border-border-hover focus-within:shadow-[0_0_0_1px_var(--color-border-hover)]">
          {slashItems.length > 0 && (
            <div className="absolute -top-1 left-0 right-0 bottom-full z-20 mb-1.5 max-h-[260px] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-2xl">
              {slashItems.map((it, i) => (
                <button
                  key={it.kind + '|' + it.name}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${i === slashCur ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`}
                  onMouseEnter={() => setSlashIx(i)}
                  onClick={() => pickSlash(it)}
                >
                  <span className="shrink-0 font-semibold text-foreground">{it.kind === 'command' ? '/' + it.name : it.name}</span>
                  <span className="flex-1 truncate text-[12px]">{it.desc.slice(0, 56)}</span>
                  <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] uppercase text-foreground-subtlest">{it.kind}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            className="w-full max-h-[180px] resize-none border-0 bg-transparent text-[14px] leading-relaxed text-foreground outline-none placeholder:text-foreground-subtlest"
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
            placeholder="Ask an agent to change code…  (type / for commands)"
            rows={2}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <ModelPicker backends={props.backends} backend={props.backend} model={props.model} onBackend={props.onBackend} onModel={props.onModel} />
            <span className="flex items-center rounded-lg bg-tag p-0.5 text-[12px]" title="Build: edit directly. Ask: approve each edit. Plan: propose first.">
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'auto' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('auto')}>Build</button>
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'ask' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('ask')}>Ask</button>
              <button className={`rounded-md px-2 py-0.5 transition-colors ${props.mode === 'plan' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => props.onMode('plan')}>Plan</button>
            </span>
            {props.onToggleTerminal && (
              <button
                className="flex size-[30px] items-center justify-center rounded-lg border border-border text-foreground-subtle transition-colors hover:border-border-hover hover:text-foreground"
                onClick={props.onToggleTerminal}
                title="Toggle terminal"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
            {props.busy ? (
              <button
                className="ml-auto flex size-8 items-center justify-center rounded-lg bg-secondary text-foreground transition-filter hover:brightness-110"
                onClick={props.onStop}
                title="Stop the agent (Esc)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button
                className="ml-auto flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-filter hover:brightness-110"
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
