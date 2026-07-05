// The left rail — makes grasp a product, not a two-pane debug tool. Wordmark, new
// session, sessions, the active project, and the theme scheme.
import { useState, useMemo } from 'react'
import { ProjectSwitcher } from './ProjectSwitcher'

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
  sessions: { id: string; title: string; workspace: string; updatedAt: number }[]
  activeSession: string
  onSelectSession: (id: string) => void
  onForkSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
  workflows: { id: string; title: string; status: string; done: number; total: number }[]
  activeWorkflow: string | null
  onOpenWorkflow: (id: string) => void
  onDeleteWorkflow: (id: string) => void
  onSearch: () => void
  onNewWorkflow: () => void
  onSettings: () => void
  theme: Theme
  onTheme: (t: Theme) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const commitRename = (id: string): void => {
    const t = draft.trim()
    setEditing(null)
    if (t) props.onRenameSession(id, t)
  }
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
      <button className="side-btn" onClick={props.onSearch}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        Search
        <span className="k">⌘K</span>
      </button>
      <button className="side-btn" onClick={props.onNewWorkflow}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 6h14M5 12h14M5 18h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="19" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.6" /></svg>
        New workflow
      </button>

      {/* Sessions grouped by project workspace (ZCode-style collapsible project headers) */}
      {(() => {
        const groups = new Map<string, typeof props.sessions>()
        for (const s of props.sessions) {
          const ws = s.workspace || 'Unknown'
          const arr = groups.get(ws) ?? []
          arr.push(s)
          groups.set(ws, arr)
        }
        for (const arr of groups.values()) arr.sort((a, b) => b.updatedAt - a.updatedAt)
        const ordered = [...groups.entries()].sort((a, b) => {
          const ac = a[0] === props.workspace ? 0 : 1
          const bc = b[0] === props.workspace ? 0 : 1
          return ac - bc
        })
        if (ordered.length === 0) return <div className="side-item active">Current session</div>
        return ordered.map(([ws, sess]) => {
          const wsName = ws.split('/').filter(Boolean).pop() ?? ws
          const collapsed = collapsedGroups.has(ws)
          const toggle = (): void => setCollapsedGroups((prev) => {
            const next = new Set(prev)
            if (next.has(ws)) next.delete(ws)
            else next.add(ws)
            return next
          })
          return (
            <div className="side-group" key={ws}>
              <div className="side-group-head" onClick={toggle}>
                <span className={`side-chevron${collapsed ? '' : ' open'}`}>▸</span>
                <span className="side-group-name">{wsName}</span>
                <span className="side-group-count">{sess.length}</span>
              </div>
              {!collapsed && sess.map((s) => (
                <div
                  key={s.id}
                  className={`side-item${s.id === props.activeSession ? ' active' : ''}`}
                  onClick={() => props.onSelectSession(s.id)}
                  title={s.title}
                >
                  {editing === s.id ? (
                    <input
                      className="si-rename"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(s.id)
                        else if (e.key === 'Escape') setEditing(null)
                      }}
                      onBlur={() => commitRename(s.id)}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="si-title">{s.title}</span>
                      <button
                        className="si-fork"
                        title="Rename"
                        onClick={(e) => { e.stopPropagation(); setEditing(s.id); setDraft(s.title) }}
                      >
                        ✎
                      </button>
                      <button
                        className="si-fork"
                        title="Fork — branch this session"
                        onClick={(e) => { e.stopPropagation(); props.onForkSession(s.id) }}
                      >
                        ⎇
                      </button>
                      <button
                        className="si-del"
                        title="Delete chat"
                        onClick={(e) => { e.stopPropagation(); props.onDeleteSession(s.id) }}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )
        })
      })()}

      {props.workflows.length > 0 && (
        <>
          <div className="side-sec">Workflows</div>
          <div className="side-list">
            {props.workflows.map((w) => (
              <div
                key={w.id}
                className={`side-item${w.id === props.activeWorkflow ? ' active' : ''}`}
                onClick={() => props.onOpenWorkflow(w.id)}
                title={w.title}
              >
                <span className="si-title">{w.title}</span>
                <span className={`wf-stat ${w.status}`}>{w.done}/{w.total}</span>
                <button
                  className="si-del"
                  title="Delete workflow"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onDeleteWorkflow(w.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="side-foot">
        <div className="theme-row">
          <button className="side-gear" onClick={props.onSettings} title="Settings">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
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
        <ProjectSwitcher workspace={props.workspace} onSwitch={props.onWorkspace} />
      </div>
    </nav>
  )
}
