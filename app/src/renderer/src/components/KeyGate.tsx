// First-run onboarding. Names what grasp is, takes a model key (encrypted via the OS
// keychain — never in the clear), and points at where projects live. Shown only when no
// key is set. Migrated to Tailwind v4 utilities matching ZCode's aesthetic.
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
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-background backdrop-blur-sm">
      <div className="flex w-[440px] max-w-[90vw] flex-col gap-5 rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <Mark />
          <div>
            <div className="text-[1.25rem] font-semibold tracking-tight text-foreground">grasp</div>
            <div className="text-[0.8125rem] text-foreground-subtlest">the post-editor</div>
          </div>
        </div>
        <p className="text-[0.8125rem] leading-relaxed text-foreground-subtle">
          Ask an agent to change code. grasp runs it for real and shows you <b className="font-semibold text-foreground">what changed</b> — the values it bound,
          the paths it took — and asks whether that&rsquo;s what you meant. It never renders a verdict; you adjudicate.
        </p>
        <ul className="flex flex-col gap-2">
          {FEATURES.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[0.8125rem] text-foreground-subtle">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
              {f}
            </li>
          ))}
        </ul>
        <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-foreground-subtlest">Connect your model</div>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          placeholder="GLM API key (z.ai / BigModel)…"
          autoFocus
          className="w-full rounded-lg border border-border bg-input px-3.5 py-3 font-mono text-[0.8125rem] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover"
        />
        <button
          onClick={() => void save()}
          disabled={busy}
          className="w-full rounded-lg bg-primary py-3 text-[0.875rem] font-semibold text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Get started'}
        </button>
        {error && <div className="text-[0.75rem] text-destructive">{error}</div>}
        <p className="text-[0.6875rem] leading-relaxed text-foreground-subtlest">
          Encrypted with your OS keychain, never written in the clear. Add OpenAI later in Settings. Your projects live
          in <code className="rounded bg-tag px-1 py-0.5 font-mono text-[0.625rem]">~/GraspProjects</code>.
        </p>
      </div>
    </div>
  )
}
