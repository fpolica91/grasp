// The left rail — makes grasp a product, not a two-pane debug tool. Wordmark, new
// session, sessions, and the workspace the agent operates in.

function Mark(): React.JSX.Element {
  // grasp's signature: a dataflow spine — a node emitting a signal down the line.
  return (
    <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 5v14" stroke="#3a434f" strokeWidth="2" strokeLinecap="round" />
      <circle cx="7" cy="5" r="3" fill="#4d8dff" />
      <circle cx="7" cy="12" r="2.4" fill="#6b7686" />
      <circle cx="7" cy="19" r="2.4" fill="#6b7686" />
      <path d="M9 12h7" stroke="#3a434f" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17" cy="12" r="2.4" fill="#e6ac5a" />
    </svg>
  )
}

export function Sidebar(props: {
  workspace: string
  onWorkspace: (w: string) => void
  onNewSession: () => void
  sessionTitle: string
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
        <div className="side-item active">{props.sessionTitle}</div>
      </div>

      <div className="side-foot">
        <div className="ws-field" title="the folder the agent works in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.7" /></svg>
          <input value={props.workspace} onChange={(e) => props.onWorkspace(e.target.value)} placeholder="workspace path" spellCheck={false} />
        </div>
      </div>
    </nav>
  )
}
