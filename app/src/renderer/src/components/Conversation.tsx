// The conversation: product-grade message rendering. Markdown with real syntax-highlighted
// code blocks (copy + collapse), subtle inline code, and TOOL CALLS as clean collapsible
// blocks (one-line summary -> expand to the command + its captured output) — never a raw
// truncated command wall. Plus plan cards, approval cards, nested subagents, a working
// provider/model picker, and a token meter.
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import type { BackendInfo } from '../../../shared/types'

export interface TranscriptItem {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'plan' | 'approval'
  text?: string
  name?: string
  input?: Record<string, unknown>
  summary?: string
  output?: string
  status?: 'running' | 'done'
  parent?: string
  streaming?: boolean // true while text deltas are appending to this assistant bubble
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
    <div className="codeblock">
      <div className="cb-head">
        <span className="cb-lang">{lang || 'text'}</span>
        <button className="cb-copy" onClick={copy}>
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre className={`cb-pre${collapsed ? ' collapsed' : ''}`}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {lineCount > 24 && (
        <button className="cb-more" onClick={() => setCollapsed((c) => !c)}>
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
    return <code className="inline-code">{children}</code>
  },
  pre({ children }: { children?: React.ReactNode }): React.JSX.Element {
    return <>{children}</>
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }): React.JSX.Element {
    return (
      <a
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
    case 'write_file':
    case 'Write':
      return { verb: 'Wrote', arg: base(path) }
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Edited', arg: base(path) }
    case 'read_file':
    case 'Read':
      return { verb: 'Read', arg: base(path) }
    case 'list_dir':
    case 'LS':
      return { verb: 'Listed', arg: base(path) || '.' }
    case 'run_bash':
    case 'Bash':
      return { verb: 'Ran', arg: cmd.slice(0, 60) || 'command' }
    case 'grasp_observe':
      return { verb: 'Observed', arg: ep }
    case 'grasp_diff':
      return { verb: 'Diffed', arg: ep }
    case 'grasp_fuzz':
      return { verb: 'Fuzzed', arg: ep }
    case 'task':
    case 'Task':
      return { verb: 'Delegated', arg: String(it.input?.description ?? it.input?.prompt ?? '').slice(0, 60) }
    default:
      return { verb: it.name ?? 'Tool', arg: path || cmd.slice(0, 60) }
  }
}

function ToolBlock({ it }: { it: TranscriptItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { verb, arg } = describe(it)
  const cmd = it.name === 'run_bash' || it.name === 'Bash' ? String(it.input?.command ?? '') : ''
  const running = it.status !== 'done'
  // The full invocation, always inspectable: the command for shell tools, otherwise the
  // tool's input (content bodies elided — the Editor shows files; this shows the call).
  const inputDetail = useMemo(() => {
    if (cmd) return null
    const inp = { ...(it.input ?? {}) }
    if (typeof inp.content === 'string') inp.content = `(${(inp.content as string).length} chars — see Editor)`
    const keys = Object.keys(inp)
    if (keys.length === 0) return null
    return JSON.stringify(inp, null, 2)
  }, [cmd, it.input])
  return (
    <div className={`toolblock${running ? ' running' : ''}${open ? ' open' : ''}`}>
      <div className="tb-head clickable" onClick={() => setOpen((o) => !o)}>
        <span className={`tb-chev${open ? ' open' : ''}`}>▸</span>
        <span className="tb-verb">{verb}</span>
        <span className="tb-arg">{arg}</span>
        {running && <span className="tb-spin" />}
      </div>
      {open && (
        <div className="tb-body">
          {cmd && <CodeBlock lang="bash" code={cmd} />}
          {inputDetail && <CodeBlock lang="json" code={inputDetail} />}
          {it.output ? (
            <pre className="tb-out">{it.output}</pre>
          ) : (
            <div className="tb-noout">{running ? 'running…' : 'no captured output for this call'}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── provider/model picker ───────────────────────────────────
function ModelPicker(props: {
  backends: BackendInfo[]
  backend: string
  model: string
  onBackend: (id: string) => void
  onModel: (m: string) => void
}): React.JSX.Element {
  const active = props.backends.find((b) => b.id === props.backend)
  return (
    <span className="picker">
      <span className={`g${active?.ok ? '' : ' off'}`} title={active?.ok ? 'available' : (active?.reason ?? 'unavailable')} />
      <select value={props.backend} onChange={(e) => props.onBackend(e.target.value)} title="agent backend">
        {props.backends.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
      <span className="sep">/</span>
      <select value={props.model} onChange={(e) => props.onModel(e.target.value)} title="model">
        {(active?.models ?? []).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </span>
  )
}

function PlanCard(props: { text: string; latest: boolean; busy: boolean; onApprove: (text: string) => void }): React.JSX.Element {
  return (
    <div className="plan-card">
      <div className="plan-head">
        <span className="eyebrow">proposed plan</span>
        <span className="plan-badge">awaiting your approval</span>
      </div>
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {props.text}
        </ReactMarkdown>
      </div>
      {props.latest && (
        <div className="plan-actions">
          <button className="btn primary" disabled={props.busy} onClick={() => props.onApprove(props.text)}>
            Approve &amp; execute
          </button>
          <span className="plan-hint">or reply below to revise the plan</span>
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
    <div className={`approval-card${decided ? ' decided' : ''}`}>
      <div className="approval-head">
        <span className="eyebrow q">approval needed</span>
        {decided && <span className={`approval-verdict ${it.summary}`}>{it.summary}</span>}
      </div>
      <div className="approval-body">
        <span className="tn">{it.name}</span>
        <span className="approval-detail">{detail}</span>
      </div>
      {!decided && (
        <div className="approval-actions">
          <button className="btn primary" onClick={() => props.onDecide(it.id!, true)}>
            Allow
          </button>
          <button className="btn" onClick={() => props.onDecide(it.id!, false)}>
            Deny
          </button>
        </div>
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
  onToggleTerminal?: () => void
  onToggleSidebar?: () => void
  banner?: React.ReactNode
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  // Stick-to-bottom ONLY when the reader is already at the bottom. Streaming events used
  // to yank the scroll down on every update, which made scrolling up and expanding tool
  // blocks impossible during a turn.
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
    stickBottom.current = true // sending re-engages follow-the-stream
    props.onSend(t)
    setInput('')
  }

  const activeLabel = props.backends.find((b) => b.id === props.backend)?.label ?? props.backend
  const top = props.transcript.filter((it) => !it.parent)

  const renderItem = (it: TranscriptItem, i: number, isLast = false): React.JSX.Element => {
    if (it.role === 'plan')
      return <PlanCard key={i} text={it.text ?? ''} latest={isLast} busy={props.busy} onApprove={props.onApprovePlan} />
    if (it.role === 'approval') return <ApprovalCard key={it.id ?? i} it={it} onDecide={props.onDecideApproval} />
    if (it.role === 'tool') {
      const kids = it.id ? props.transcript.filter((k) => k.parent === it.id) : []
      const chip = <ToolBlock key={it.id ?? i} it={it} />
      if ((it.name === 'task' || it.name === 'Task') && kids.length > 0)
        return (
          <div key={it.id ?? i} className="subagent">
            {chip}
            <div className="subagent-body">{kids.map((k, ki) => renderItem(k, ki))}</div>
          </div>
        )
      return chip
    }
    if (it.role === 'user')
      return (
        <div key={i} className="msg user">
          <div className="bubble">{it.text}</div>
        </div>
      )
    return (
      <div key={i} className="msg assistant">
        <div className="prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {it.text ?? ''}
          </ReactMarkdown>
        </div>
      </div>
    )
  }

  return (
    <section className="conv">
      <header className="conv-head">
        {props.onToggleSidebar && (
          <button className="head-icon" onClick={props.onToggleSidebar} title="Toggle sidebar (⌘B)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM9 5v14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        <span className="conv-title">
          Session<span className="sub">post-editor</span>
        </span>
        <span className="meter" title="tokens used this session · optional per-turn budget">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".4" />
            <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {fmtTokens(props.tokens)}
          <span className="meter-sep">budget</span>
          <input
            className="budget"
            value={props.budget}
            onChange={(e) => props.onBudget(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="none"
            spellCheck={false}
          />
        </span>
        <span className="chip">
          <span className="g" />
          {activeLabel} · {props.model}
        </span>
      </header>

      {props.banner}

      <div className="conv-log" ref={logRef} onScroll={onLogScroll}>
        {props.transcript.length === 0 && (
          <div className="conv-empty">
            <h2>What should we change?</h2>
            <p>
              Ask an agent to edit code in your project. As it works, the file, the diff, and the observed dataflow
              show on the right — you adjudicate what the change did, never a &ldquo;does it work&rdquo;.
            </p>
          </div>
        )}
        {top.map((it, i) => renderItem(it, i, i === top.length - 1))}
        {/* The working dots show while the agent runs tools or waits — but not while text is
            streaming into a bubble (the growing text is itself the activity signal). */}
        {props.busy && !props.transcript.some((it) => it.streaming) && (
          <div className="msg assistant">
            <div className="working">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
        {props.error && <div className="msg-error">{props.error}</div>}
      </div>

      <div className="composer">
        <div className="box">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Ask an agent to change code…"
            rows={2}
            autoFocus
          />
          <div className="row">
            <ModelPicker
              backends={props.backends}
              backend={props.backend}
              model={props.model}
              onBackend={props.onBackend}
              onModel={props.onModel}
            />
            <span
              className="mode-toggle"
              title="Build: edit directly. Ask: approve each edit. Plan: propose first — nothing changes until you approve."
            >
              <button className={props.mode === 'auto' ? 'on' : ''} onClick={() => props.onMode('auto')}>
                Build
              </button>
              <button className={props.mode === 'ask' ? 'on' : ''} onClick={() => props.onMode('ask')}>
                Ask
              </button>
              <button className={props.mode === 'plan' ? 'on' : ''} onClick={() => props.onMode('plan')}>
                Plan
              </button>
            </span>
            {props.onToggleTerminal && (
              <button className="composer-icon" onClick={props.onToggleTerminal} title="Toggle terminal panel">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
            {props.busy ? (
              <button className="send stop" onClick={props.onStop} title="Stop the agent">
                <svg width="13" height="13" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button className="send" onClick={submit} title="Send (Enter · Shift+Enter for newline)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
