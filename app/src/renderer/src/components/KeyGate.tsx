// First-run gate: paste a model key. Stored encrypted via the OS keychain (main/vault),
// never in the clear. Shown only when no key is set.
import { useState } from 'react'

export function KeyGate({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    const k = key.trim()
    if (!k || busy) return
    setBusy(true)
    setError(null)
    const r = await window.grasp.setKey(k)
    setBusy(false)
    if (r.ok) onSaved()
    else setError(r.error ?? 'could not save')
  }

  return (
    <div className="gate-overlay">
      <div className="gate">
        <div className="brand">grasp</div>
        <h2>Connect your model</h2>
        <p>
          Paste a GLM API key (z.ai / BigModel). It is encrypted with your OS keychain and never written in the clear.
        </p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          placeholder="glm api key…"
          autoFocus
        />
        <button onClick={() => void save()} disabled={busy}>
          Save &amp; continue
        </button>
        {error && <div className="gate-error">{error}</div>}
      </div>
    </div>
  )
}
