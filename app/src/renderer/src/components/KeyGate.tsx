// First-run onboarding. Names what grasp is, takes a model key (encrypted via the OS
// keychain — never in the clear), and points at where projects live. Shown only when no
// key is set.
import { useState } from 'react'

function Mark(): React.JSX.Element {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 5v14" stroke="var(--ghost)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="7" cy="5" r="3" fill="var(--accent)" />
      <circle cx="7" cy="12" r="2.4" fill="var(--faint)" />
      <circle cx="7" cy="19" r="2.4" fill="var(--faint)" />
      <path d="M9 12h7" stroke="var(--ghost)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17" cy="12" r="2.4" fill="var(--question)" />
    </svg>
  )
}

const FEATURES = [
  'Watch the observed dataflow — grasp runs the change for real, no configuration.',
  'A full workbench in-app: editor, terminal, browser, and pluggable agents.',
  'Plan / Ask / Build modes — you decide how much to approve.'
]

export function KeyGate({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    const k = key.trim()
    if (!k || busy) return
    setBusy(true)
    setError(null)
    const r = await window.grasp.setKey(k, 'glm')
    setBusy(false)
    if (r.ok) onSaved()
    else setError(r.error ?? 'could not save')
  }

  return (
    <div className="gate-overlay">
      <div className="gate onboarding">
        <div className="ob-head">
          <Mark />
          <div>
            <div className="ob-title">grasp</div>
            <div className="ob-sub">the post-editor</div>
          </div>
        </div>
        <p className="ob-lede">
          Ask an agent to change code. grasp runs it for real and shows you <b>what changed</b> — the values it bound,
          the paths it took — and asks whether that&rsquo;s what you meant. It never renders a verdict; you adjudicate.
        </p>
        <ul className="ob-features">
          {FEATURES.map((f, i) => (
            <li key={i}>
              <span className="ob-dot" />
              {f}
            </li>
          ))}
        </ul>
        <div className="ob-field-label">Connect your model</div>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          placeholder="GLM API key (z.ai / BigModel)…"
          autoFocus
        />
        <button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Get started'}
        </button>
        {error && <div className="gate-error">{error}</div>}
        <p className="ob-foot">
          Encrypted with your OS keychain, never written in the clear. Add OpenAI later in Settings. Your projects live
          in <code>~/GraspProjects</code>.
        </p>
      </div>
    </div>
  )
}
