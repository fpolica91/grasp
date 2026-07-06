// Model trajectory — a faithful clone of ZCode's "Model trajectory" inspector.
// Each entry is one LLM API call (#N) with its Input (messages by role: System / User /
// Assistant / Tool), Reasoning (thinking), Tool calls, Output, and Tool results. This is
// a developer request/response view of every model round-trip — grayscale, IDE-debug feel,
// monospace payloads, collapsible. NOT a chat.
import { useState } from 'react'
import type { TrajectoryCall } from '../../../shared/types'

type Role = 'system' | 'user' | 'assistant' | 'tool'

const ROLE_LABEL: Record<Role, string> = { system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' }
// A whisper of color per role — the screenshot is grayscale, but a single dot aids scanning.
const ROLE_DOT: Record<Role, string> = {
  system: 'bg-foreground-subtlest',
  user: 'bg-accent-blue',
  assistant: 'bg-foreground',
  tool: 'bg-accent-green'
}

function fmtTok(n?: number): string {
  if (!n && n !== 0) return ''
  return n.toLocaleString()
}

// One role-labeled payload block (a System/User/Assistant/Tool message rendered as a card).
function RoleBlock({ role, text }: { role: Role; text: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-panel">
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1">
        <span className={`size-1.5 rounded-full ${ROLE_DOT[role]}`} />
        <span className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtlest">{ROLE_LABEL[role]}</span>
      </div>
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground-subtle">{text}</pre>
    </div>
  )
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-subtlest">{children}</span>
      {right && <span className="font-mono text-[10px] text-foreground-subtlest/70">{right}</span>}
    </div>
  )
}

function Call({ call }: { call: TrajectoryCall }): React.JSX.Element {
  const [open, setOpen] = useState(call.n <= 3) // first few open, rest collapsed
  const inTok = fmtTok(call.inputTokens)
  const outTok = fmtTok(call.outputTokens)
  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Header — the #N row: number · model · source · tokens · duration */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
      >
        <svg width="9" height="9" viewBox="0 0 12 12" className={`shrink-0 text-foreground-subtlest transition-transform ${open ? 'rotate-90' : ''}`}><path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="font-mono text-[12px] font-medium text-foreground">#{call.n}</span>
        <span className="text-[12px] text-foreground-subtle">{call.model}</span>
        <span className="text-[12px] text-foreground-subtlest">·</span>
        <span className="text-[12px] text-foreground-subtlest">{call.source}</span>
        {(inTok || outTok) && (
          <span className="ml-1 font-mono text-[11px] text-foreground-subtlest">
            tool-calls <span className="text-foreground-subtle">in {inTok} out {outTok}</span>
          </span>
        )}
        {call.ms !== undefined && (
          <span className="ml-auto font-mono text-[11px] text-foreground-subtlest">{(call.ms / 1000).toFixed(1)}s</span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
          {call.system && (
            <>
              <SectionLabel>Input</SectionLabel>
              <RoleBlock role="system" text={call.system} />
            </>
          )}
          {/* Input messages (non-system): show the role label only when system was absent */}
          {call.input.filter((m) => m.role !== 'system').length > 0 && !call.system && <SectionLabel>Input</SectionLabel>}
          {call.input.filter((m) => m.role !== 'system').map((m, i) => (
            <RoleBlock key={i} role={m.role} text={m.text} />
          ))}
          {call.reasoning && (
            <>
              <SectionLabel right={`${(call.reasoning.length / 1000).toFixed(1)}k chars`}>Reasoning</SectionLabel>
              <RoleBlock role="assistant" text={call.reasoning} />
            </>
          )}
          {call.toolCalls.map((tc, i) => (
            <div key={`tc-${i}`}>
              <SectionLabel right={tc.name}>Tool call</SectionLabel>
              <RoleBlock role="tool" text={JSON.stringify(tc.input, null, 2)} />
            </div>
          ))}
          {call.output && (
            <>
              <SectionLabel>Output</SectionLabel>
              <RoleBlock role="assistant" text={call.output} />
            </>
          )}
          {call.toolResults.map((tr, i) => (
            <div key={`tr-${i}`}>
              <SectionLabel right={tr.name}>Tool result</SectionLabel>
              <RoleBlock role="tool" text={tr.output} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function TrajectoryInspector({ calls }: { calls: TrajectoryCall[] }): React.JSX.Element {
  if (calls.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-surface text-foreground-subtlest">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="18.5" cy="17.5" r="2.5" stroke="currentColor" strokeWidth="1.4" /></svg>
        </div>
        <p className="text-[14px] font-medium text-foreground">Model trajectory</p>
        <p className="max-w-[300px] text-[13px] text-foreground-subtlest">Every model call recorded as you converse — input, reasoning, tool calls, output — like a network inspector for the agent.</p>
      </div>
    )
  }
  const totalIn = calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0)
  const totalOut = calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0)
  const model = calls[0]?.model ?? ''
  return (
    <div className="flex h-full flex-col">
      {/* Toolbar — sess id · N calls · Σ tokens · model (ZCode style) */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-[11px] text-foreground-subtlest">
        <span className="font-mono"><span className="text-foreground-subtle">{calls.length}</span> calls</span>
        <span className="text-foreground-subtlest/50">·</span>
        <span>Σ <span className="font-mono text-foreground-subtle">{(totalIn + totalOut).toLocaleString()}</span> tok</span>
        <span className="text-foreground-subtlest/50">·</span>
        <span className="font-mono text-foreground-subtle">in {totalIn.toLocaleString()} out {totalOut.toLocaleString()}</span>
        {model && <span className="ml-auto rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-foreground-subtle">{model}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1.5 p-3">
          {calls.map((c) => <Call key={c.n} call={c} />)}
        </div>
      </div>
    </div>
  )
}
