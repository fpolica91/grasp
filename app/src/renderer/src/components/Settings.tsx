// Settings — API keys per provider (stored in the safeStorage vault, namespaced), and
// appearance. Closes the S2 gap: an OpenAI key can be added entirely in-app, which flips
// the OpenAI backend to available without an env var.
import { useEffect, useState } from 'react'
import type { Theme } from './Sidebar'

const PROVIDERS: { id: string; label: string; hint: string }[] = [
  { id: 'glm', label: 'GLM (Z.ai)', hint: 'z.ai API key — powers glm-4.6 / glm-5.2' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-… (or any OpenAI-compatible key)' }
]

const THEMES: { id: Theme; label: string }[] = [
  { id: 'graphite', label: 'Graphite' },
  { id: 'carbon', label: 'Carbon' },
  { id: 'daylight', label: 'Daylight' }
]

function KeyRow({ provider, label, hint, onSaved }: { provider: string; label: string; hint: string; onSaved: () => void }): React.JSX.Element {
  const [has, setHas] = useState(false)
  const [val, setVal] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void window.grasp.keyStatus(provider).then(setHas)
  }, [provider])
  const save = async (): Promise<void> => {
    const r = await window.grasp.setKey(val.trim(), provider)
    if (r.ok) {
      setHas(true)
      setVal('')
      setMsg(r.warning ?? 'saved')
      onSaved()
    } else {
      setMsg(r.error ?? 'failed')
    }
    setTimeout(() => setMsg(''), 2500)
  }
  return (
    <div className="set-key">
      <div className="set-key-head">
        <span className="set-key-label">{label}</span>
        <span className={`set-key-dot${has ? ' on' : ''}`}>{has ? 'key set' : 'no key'}</span>
      </div>
      <div className="set-key-row">
        <input
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && val.trim()) void save()
          }}
          placeholder={has ? 'replace key…' : 'paste key…'}
          spellCheck={false}
        />
        <button className="btn sm primary" disabled={!val.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
      <div className="set-key-hint">
        {hint}
        {msg && <span className="set-key-msg"> · {msg}</span>}
      </div>
    </div>
  )
}

export function Settings(props: { theme: Theme; onTheme: (t: Theme) => void; onKeysChanged: () => void; onClose: () => void }): React.JSX.Element {
  return (
    <div className="gate-overlay" onClick={props.onClose}>
      <div className="gate settings" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <h2>Settings</h2>
          <button className="head-icon" onClick={props.onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="set-section">
          <div className="eyebrow">API keys</div>
          <p className="set-note">Stored encrypted in your OS keychain (safeStorage) — never written in plaintext.</p>
          {PROVIDERS.map((p) => (
            <KeyRow key={p.id} provider={p.id} label={p.label} hint={p.hint} onSaved={props.onKeysChanged} />
          ))}
        </div>

        <div className="set-section">
          <div className="eyebrow">Appearance</div>
          <div className="set-themes">
            {THEMES.map((t) => (
              <button key={t.id} className={`set-theme${props.theme === t.id ? ' on' : ''}`} onClick={() => props.onTheme(t.id)}>
                <span className={`theme-dot ${t.id}`} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
