// Remote-Connect — a single-form "Connect to remote" modal (matches ZCode's dialog).
// Actually tests the SSH connection via the system ssh binary (BatchMode +
// StrictHostKeyChecking=yes) and reports real success/failure. The verified host is
// remembered so the agent's remote_bash tool can target it.
import { useState } from 'react'

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

export function RemoteConnect({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [host, setHost] = useState(() => localStorage.getItem('grasp-remote-host') ?? '')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [test, setTest] = useState<TestState>('idle')
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')

  // The host string the agent's remote_bash expects: user@host (port via ~/.ssh/config).
  const sshTarget = [user.trim(), host.trim()].filter(Boolean).join(host.trim() && user.trim() ? '@' : '')

  const runTest = async (): Promise<void> => {
    if (!sshTarget) return
    setTest('testing'); setError(''); setOutput('')
    const r = await window.grasp.sshTest(sshTarget)
    if (r.ok) {
      setTest('ok'); setOutput(r.output || '')
      localStorage.setItem('grasp-remote-host', sshTarget)
    } else {
      setTest('fail'); setError(r.error || 'SSH connection failed')
    }
  }

  const fieldCls = 'w-full rounded-lg border border-border bg-input px-3.5 py-2.5 text-[14px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover'
  const labelCls = 'mb-1.5 block text-[12px] font-medium text-foreground-subtle'

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-[3px]" onClick={onClose}>
      <div className="flex w-[480px] max-w-[90vw] flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold tracking-tight text-foreground">Connect to remote</h2>
          <button className="border-0 bg-transparent text-[16px] text-foreground-subtlest transition-colors hover:text-foreground" onClick={onClose}>✕</button>
        </div>

        {/* Form — single column, labels above inputs (ZCode layout) */}
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>Host</label>
            <input className={fieldCls} placeholder="ssh.example.com or IP" value={host} onChange={(e) => { setHost(e.target.value); setTest('idle') }} spellCheck={false} />
          </div>
          <div className="flex gap-3">
            <div className="w-[88px] shrink-0">
              <label className={labelCls}>Port</label>
              <input className={fieldCls} value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
            <div className="min-w-0 flex-1">
              <label className={labelCls}>User</label>
              <input className={fieldCls} placeholder="ubuntu" value={user} onChange={(e) => { setUser(e.target.value); setTest('idle') }} spellCheck={false} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Identity file <span className="font-normal text-foreground-subtlest">(optional)</span></label>
            <input className={`${fieldCls} font-mono text-[13px]`} placeholder="~/.ssh/id_ed25519" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} spellCheck={false} />
            <p className="mt-1.5 text-[11px] leading-relaxed text-foreground-subtlest">
              grasp uses your system SSH with key-based auth only (BatchMode + StrictHostKeyChecking=yes — no password prompts, unknown hosts refused). For non-default ports or aliases, configure them in <code className="rounded bg-tag px-1 font-mono">~/.ssh/config</code>.
            </p>
          </div>
        </div>

        {/* Test result */}
        {test === 'testing' && (
          <div className="flex items-center gap-2.5 text-[13px] text-foreground-subtle">
            <span className="size-2.5 animate-pulse rounded-full bg-accent-blue" />
            Testing connection to <span className="font-mono text-foreground">{sshTarget}</span>…
          </div>
        )}
        {test === 'ok' && (
          <div className="rounded-lg border border-border bg-background px-3 py-2.5 text-[12px] text-foreground-subtle">
            <div className="flex items-center gap-2 font-medium text-success">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Connected. Host remembered.
            </div>
            <p className="mt-1 leading-relaxed">The agent can run commands on <span className="font-mono text-foreground">{sshTarget}</span> via <code className="rounded bg-tag px-1 font-mono">remote_bash</code> with <span className="font-mono">host="{sshTarget}"</span>.</p>
          </div>
        )}
        {test === 'fail' && (
          <div className="rounded-lg border border-destructive/40 bg-background px-3 py-2.5 text-[12px] text-destructive">
            <div className="flex items-center gap-2 font-medium">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" /></svg>
              Connection failed
            </div>
            <pre className="mt-1 max-h-[80px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-destructive/90">{error}</pre>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button className="rounded-lg border border-border bg-secondary px-3.5 py-2 text-[13px] font-medium text-foreground transition-filter hover:brightness-110" onClick={onClose}>Cancel</button>
          <button
            className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110 disabled:opacity-50"
            disabled={!sshTarget || test === 'testing'}
            onClick={() => void runTest()}
          >
            {test === 'ok' ? 'Reconnect' : test === 'testing' ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
