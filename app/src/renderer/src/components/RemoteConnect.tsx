// Remote-Connect — "Connect to remote" modal (VS Code Remote-SSH style).
// Establishes a PERSISTENT ssh2 session; on success the workspace switches to the
// remote home and the agent + editor + terminal run ON THAT MACHINE. Auth via private
// key or password (toggle). Real errors are surfaced.
import { useState } from 'react'

type AuthMode = 'key' | 'password'

export function RemoteConnect(props: {
  onClose: () => void
  onConnected: (r: { host: string; user: string; cwd: string }) => void
}): React.JSX.Element {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [auth, setAuth] = useState<AuthMode>('key')
  const [keyPath, setKeyPath] = useState('~/.ssh/id_rsa')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connect = async (): Promise<void> => {
    if (!host.trim() || !user.trim()) { setError('Host and user are required.'); return }
    setBusy(true); setError('')
    const r = await window.grasp.remoteConnect({
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      user: user.trim(),
      ...(auth === 'key' ? { keyPath: keyPath.trim(), passphrase: passphrase.trim() || undefined } : { password })
    })
    setBusy(false)
    if (r.ok && r.cwd) {
      props.onConnected({ host: host.trim(), user: user.trim(), cwd: r.cwd })
      props.onClose()
    } else {
      setError(r.error || 'Connection failed')
    }
  }

  const field = 'w-full rounded-lg border border-border bg-input px-3.5 py-2.5 text-[0.875rem] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover'
  const label = 'mb-1.5 block text-[0.75rem] font-medium text-foreground-subtle'

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-[3px]" onClick={props.onClose}>
      <div className="flex w-[480px] max-w-[90vw] flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[1rem] font-semibold tracking-tight text-foreground">Connect to remote</h2>
            <p className="mt-0.5 text-[0.75rem] text-foreground-subtlest">The agent, editor, and terminal will run on the remote machine.</p>
          </div>
          <button className="border-0 bg-transparent text-[1rem] text-foreground-subtlest transition-colors hover:text-foreground" onClick={props.onClose}>✕</button>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className={label}>Host</label>
            <input className={field} placeholder="spark or ssh.example.com" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
          </div>
          <div className="flex gap-3">
            <div className="w-[88px] shrink-0">
              <label className={label}>Port</label>
              <input className={field} value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
            <div className="min-w-0 flex-1">
              <label className={label}>User</label>
              <input className={field} placeholder="fabricio" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
            </div>
          </div>

          {/* auth mode toggle */}
          <div className="flex gap-1 self-start rounded-lg border border-border bg-background p-0.5 text-[0.75rem]">
            {(['key', 'password'] as const).map((m) => (
              <button key={m} className={`rounded-md px-3 py-1 capitalize transition-colors ${auth === m ? 'bg-secondary text-foreground' : 'text-foreground-subtlest hover:text-foreground'}`} onClick={() => setAuth(m)}>{m}</button>
            ))}
          </div>

          {auth === 'key' ? (
            <>
              <div>
                <label className={label}>Identity file</label>
                <input className={`${field} font-mono text-[0.8125rem]`} placeholder="~/.ssh/id_ed25519" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} spellCheck={false} />
              </div>
              <div>
                <label className={label}>Passphrase <span className="font-normal text-foreground-subtlest">(optional)</span></label>
                <input className={field} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} spellCheck={false} />
              </div>
            </>
          ) : (
            <div>
              <label className={label}>Password</label>
              <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} spellCheck={false} />
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-background px-3 py-2.5 text-[0.75rem] text-destructive">
            <div className="flex items-center gap-2 font-medium">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" /><path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
              Connection failed
            </div>
            <pre className="mt-1 max-h-[80px] overflow-auto whitespace-pre-wrap font-mono text-[0.6875rem] text-destructive/90">{error}</pre>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button className="rounded-lg border border-border bg-secondary px-3.5 py-2 text-[0.8125rem] font-medium text-foreground transition-filter hover:brightness-110" onClick={props.onClose}>Cancel</button>
          <button className="rounded-lg bg-primary px-4 py-2 text-[0.8125rem] font-semibold text-primary-foreground shadow-sm transition-filter hover:brightness-110 disabled:opacity-50" disabled={busy || !host.trim() || !user.trim()} onClick={() => void connect()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
