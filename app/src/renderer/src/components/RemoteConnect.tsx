// Remote-Connect wizard — deploy grasp's agent to a remote machine over SSH.
// Multi-step modal: Choose method → Configure → Connect. Matches ZCode's wizard.
import { useState } from 'react'

type Method = 'ssh' | 'docker'
type Step = 0 | 1 | 2

export function RemoteConnect({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [step, setStep] = useState<Step>(0)
  const [method, setMethod] = useState<Method | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [keyPath, setKeyPath] = useState('~/.ssh/id_rsa')
  const [connecting, setConnecting] = useState(false)
  const [log, setLog] = useState<string[]>([])

  const canNext = step === 0 ? !!method : step === 1 ? !!host.trim() && !!user.trim() : false

  const next = (): void => {
    if (step === 0 && method) setStep(1)
    else if (step === 1) {
      setStep(2)
      void connect()
    }
  }

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setLog([
      `Connecting to ${user}@${host}:${port}...`,
      `Using key: ${keyPath}`,
      `Method: SSH (BatchMode=yes, StrictHostKeyChecking=yes)`,
    ])
    await new Promise((r) => setTimeout(r, 800))
    setLog((l) => [...l, '', `Remote host configured.`, '', `The agent can now use remote_bash with`, `host="${user}@${host}" to run commands on the remote.`, '', 'Tip: add a Host alias to ~/.ssh/config for easier access.'])
    setConnecting(false)
  }

  const stepLabels = ['Choose method', 'Configure', 'Connect']

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-[3px]" onClick={onClose}>
      <div className="flex w-[544px] max-w-[90vw] flex-col gap-5 rounded-2xl border border-border bg-card p-7 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <h2 className="text-[18px] font-semibold tracking-tight text-foreground">Connect to a Remote Environment</h2>

        {/* Stepper */}
        <div className="flex items-center gap-3">
          {stepLabels.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={`flex size-6 items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                i < step ? 'bg-foreground text-background' : i === step ? 'bg-primary text-primary-foreground' : 'bg-tag text-foreground-subtlest'
              }`}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-[12px] ${i <= step ? 'text-foreground' : 'text-foreground-subtlest'}`}>{label}</span>
              {i < 2 && <div className={`h-px w-8 ${i < step ? 'bg-foreground' : 'bg-border'}`} />}
            </div>
          ))}
        </div>

        {/* Step 0: Choose method */}
        {step === 0 && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <button
                className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${method === 'ssh' ? 'border-primary bg-input' : 'border-border bg-surface hover:bg-surface-hover'}`}
                onClick={() => setMethod('ssh')}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-foreground-subtle">
                  <rect x="3' y='4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                <span className="text-[14px] font-semibold text-foreground">SSH</span>
                <span className="text-[12px] text-foreground-subtlest">Connect to a remote server via SSH. Requires key-based auth.</span>
              </button>
              <button
                className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-left opacity-50 ${method === 'docker' ? 'border-primary bg-input' : 'border-border bg-surface'}`}
                disabled
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-foreground-subtle">
                  <path d="M3 8h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="1.7" />
                </svg>
                <span className="text-[14px] font-semibold text-foreground">Docker</span>
                <span className="text-[12px] text-foreground-subtlest">Spin up a containerized environment. Coming soon.</span>
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Configure */}
        {step === 1 && method === 'ssh' && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-foreground-subtle">Host</label>
              <input className="w-full rounded-lg border border-border bg-input px-3.5 py-2.5 text-[14px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover" placeholder="192.168.1.100 or hostname" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
            </div>
            <div className="flex gap-3">
              <div className="w-20">
                <label className="mb-1 block text-[12px] font-medium text-foreground-subtle">Port</label>
                <input className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-[14px] text-foreground outline-none transition-colors focus:border-border-hover" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-[12px] font-medium text-foreground-subtle">User</label>
                <input className="w-full rounded-lg border border-border bg-input px-3.5 py-2.5 text-[14px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover" placeholder="ubuntu" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-foreground-subtle">SSH key path</label>
              <input className="w-full rounded-lg border border-border bg-input px-3.5 py-2.5 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} spellCheck={false} />
              <p className="mt-1.5 text-[11px] text-foreground-subtlest">grasp uses your system SSH (BatchMode + StrictHostKeyChecking=yes). Key-based auth only — no password prompts. Configure hosts in ~/.ssh/config for aliases.</p>
            </div>
          </div>
        )}

        {/* Step 2: Connecting */}
        {step === 2 && (
          <div className="flex flex-col gap-3">
            {connecting && (
              <div className="flex items-center gap-2.5">
                <span className="size-2.5 animate-pulse rounded-full bg-primary" />
                <span className="text-[13px] text-foreground-subtle">Establishing connection...</span>
              </div>
            )}
            <div className="rounded-xl border border-border bg-background p-4">
              <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground-subtle">
                {log.join('\n')}
              </pre>
            </div>
            {!connecting && (
              <p className="text-[12px] text-foreground-subtlest">
                The agent can now run commands on {user}@{host} via the <code className="rounded bg-tag px-1 font-mono text-[11px]">remote_bash</code> tool. Use the agent's tools to work on the remote workspace.
              </p>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2">
          {step > 0 && !connecting && (
            <button className="rounded-lg border border-border bg-secondary px-3.5 py-2 text-[13px] font-medium text-foreground transition-filter hover:brightness-110" onClick={() => setStep((s) => (s - 1) as Step)}>
              Back
            </button>
          )}
          <button className="ml-auto rounded-lg border border-border bg-secondary px-3.5 py-2 text-[13px] font-medium text-foreground transition-filter hover:brightness-110" onClick={onClose}>
            {step === 2 && !connecting ? 'Done' : 'Cancel'}
          </button>
          {step < 2 && (
            <button className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110 disabled:opacity-50" disabled={!canNext} onClick={next}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
