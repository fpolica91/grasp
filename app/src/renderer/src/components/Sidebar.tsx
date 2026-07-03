// The left rail — makes grasp a product, not a two-pane debug tool. Wordmark, new
// session, sessions, the workspace the agent operates in, and the theme scheme.
export type Theme = 'graphite' | 'carbon' | 'daylight'
const THEMES: { id: Theme; label: string }[] = [
  { id: 'graphite', label: 'Graphite' },
  { id: 'carbon', label: 'Carbon' },
  { id: 'daylight', label: 'Daylight' }
]

function Mark(): React.JSX.Element {
  // grasp's signature: a dataflow spine — a signal source branching to the question.
  // Tokenized so it reads on every scheme; blue source → amber question is the brand.
  return (
    <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 5v14" stroke="var(--ghost)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="7" cy="5" r="3" fill="var(--accent)" />
      <circle cx="7" cy="12" r="2.4" fill="var(--faint)" />
      <circle cx="7" cy="19" r="2.4" fill="var(--faint)" />
      <path d="M9 12h7" stroke="var(--ghost)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17" cy="12" r="2.4" fill="var(--question)" />
    </svg>
  )
}

export function Sidebar(props: {
  workspace: string
  onWorkspace: (w: string) => void
  onNewSession: () => void
  sessions: { id: string; title: string }[]
  activeSession: string
  onSelectSession: (id: string) => void
  theme: Theme
  onTheme: (t: Theme) => void
}): React.JSX.Element {
  return (
    <nav className="sidebar">
      <div className="brand">
        <Mark />
        <span className="name">grasp</span>
        <span className="dot" title="live" />
      </div>

      <button className="side-btn primary" onClick={props.onNewSession}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        New session
        <span className="k">⌘N</span>
      </button>
      <button className="side-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        Search
        <span className="k">⌘K</span>
      </button>

      <div className="side-sec">Sessions</div>
      <div className="side-list">
        {props.sessions.length === 0 && <div className="side-item active">Current session</div>}
        {props.sessions.map((s) => (
          <div
            key={s.id}
            className={`side-item${s.id === props.activeSession ? ' active' : ''}`}
            onClick={() => props.onSelectSession(s.id)}
            title={s.title}
          >
            {s.title}
          </div>
        ))}
      </div>

      <div className="side-foot">
        <div className="theme-row">
          <span className="tlabel">Theme</span>
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-dot ${t.id}${props.theme === t.id ? ' on' : ''}`}
              onClick={() => props.onTheme(t.id)}
              title={t.label}
              aria-label={`${t.label} theme`}
            />
          ))}
        </div>
        <div className="ws-field" title="the folder the agent works in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.7" /></svg>
          <input value={props.workspace} onChange={(e) => props.onWorkspace(e.target.value)} placeholder="workspace path" spellCheck={false} />
        </div>
      </div>
    </nav>
  )
}
