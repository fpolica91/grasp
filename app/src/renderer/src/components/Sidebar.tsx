// The left rail — makes grasp a product, not a two-pane debug tool. Wordmark, new
// session, sessions, the active project, and the theme scheme.
// Migrated to Tailwind v4 utilities matching ZCode's aesthetic.
import { useState } from 'react'
import { ProjectSwitcher } from './ProjectSwitcher'

export type Theme = 'graphite' | 'carbon' | 'daylight'
const THEMES: { id: Theme; label: string; dot: string }[] = [
  { id: 'graphite', label: 'ZCode Dark', dot: 'linear-gradient(135deg,#161616 50%,#4099ff 50%)' },
  { id: 'carbon', label: 'Carbon', dot: 'linear-gradient(135deg,#0d0d0d 50%,#7b5ce5 50%)' },
  { id: 'daylight', label: 'ZCode Light', dot: 'linear-gradient(135deg,#f8f8f8 50%,#0b7fff 50%)' }
]

function Mark(): React.JSX.Element {
  return (
    <svg className="size-7 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 5v14" stroke="var(--ghost)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="7" cy="5" r="3" fill="var(--accent)" />
      <circle cx="7" cy="12" r="2.4" fill="var(--faint)" />
      <circle cx="7" cy="19" r="2.4" fill="var(--faint)" />
      <path d="M9 12h7" stroke="var(--ghost)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17" cy="12" r="2.4" fill="var(--question)" />
    </svg>
  )
}

function SessionRow({
  id,
  title,
  isActive,
  isEditing,
  draft,
  onSelect,
  onRename,
  onFork,
  onDelete,
  onDraftChange,
  onCommitRename,
  onCancelRename
}: {
  id: string
  title: string
  isActive: boolean
  isEditing: boolean
  draft: string
  onSelect: () => void
  onRename: () => void
  onFork: () => void
  onDelete: () => void
  onDraftChange: (v: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
}): React.JSX.Element {
  if (isEditing) {
    return (
      <div className="flex items-center rounded-md px-2 py-1.5">
        <input
          className="flex-1 rounded border border-border-hover bg-input px-1.5 py-0.5 text-[13px] text-foreground outline-none"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitRename()
            else if (e.key === 'Escape') onCancelRename()
          }}
          onBlur={onCommitRename}
          autoFocus
        />
      </div>
    )
  }
  return (
    <div
      className={`group flex cursor-pointer items-center rounded-md px-2 py-1.5 text-[13px] transition-colors ${
        isActive ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'
      }`}
      onClick={onSelect}
      title={title}
    >
      <span className="flex-1 truncate">{title}</span>
      <button className="ml-auto shrink-0 rounded p-0.5 text-[11px] text-foreground-subtlest opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100" title="Rename" onClick={(e) => { e.stopPropagation(); onRename() }}>
        ✎
      </button>
      <button className="shrink-0 rounded p-0.5 text-[11px] text-foreground-subtlest opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100" title="Fork" onClick={(e) => { e.stopPropagation(); onFork() }}>
        ⎇
      </button>
      <button className="shrink-0 rounded p-0.5 text-[11px] text-foreground-subtlest opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete() }}>
        ✕
      </button>
    </div>
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
  skills: { name: string; description: string; enabled: boolean }[]
  onToggleSkill: (name: string, enabled: boolean) => void
  onSearch: () => void
  onNewWorkflow: () => void
  onSettings: () => void
  onRemote: () => void
  theme: Theme
  onTheme: (t: Theme) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')

  const commitRename = (id: string): void => {
    const t = draft.trim()
    setEditing(null)
    if (t) props.onRenameSession(id, t)
  }

  // Group sessions by workspace
  const groups: [string, typeof props.sessions][] = (() => {
    const map = new Map<string, typeof props.sessions>()
    for (const s of props.sessions) {
      const ws = s.workspace || 'Unknown'
      const arr = map.get(ws) ?? []
      arr.push(s)
      map.set(ws, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => sortOrder === 'newest' ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt)
    return [...map.entries()].sort((a, b) => {
      const ac = a[0] === props.workspace ? 0 : 1
      const bc = b[0] === props.workspace ? 0 : 1
      return ac - bc
    })
  })()

  return (
    <nav className="flex h-full flex-col gap-1 overflow-hidden bg-background p-3" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Brand */}
      <div className="flex items-center gap-2 px-1 pb-1">
        <Mark />
        <span className="text-[15px] font-semibold tracking-tight text-foreground">grasp</span>
      </div>

      {/* Action buttons */}
      <button
        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-hover"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={props.onNewSession}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        New session
        <span className="ml-auto font-mono text-[11px] text-foreground-subtlest">⌘N</span>
      </button>
      <button
        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={props.onSearch}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        Search
        <span className="ml-auto font-mono text-[11px] text-foreground-subtlest">⌘K</span>
      </button>
      <button
        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-foreground-subtle transition-colors hover:bg-surface-hover"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={props.onNewWorkflow}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 6h14M5 12h14M5 18h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="19" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.6" /></svg>
        New workflow
      </button>

      {/* Sessions grouped by project */}
      {groups.length > 0 && (
        <div className="mt-2 flex items-center px-2.5 pb-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">Conversations</span>
          <button
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground-subtle"
            title={sortOrder === 'newest' ? 'Newest first — click for oldest' : 'Oldest first — click for newest'}
            onClick={() => setSortOrder((s) => (s === 'newest' ? 'oldest' : 'newest'))}
          >
            {sortOrder === 'newest' ? '↓ New' : '↑ Old'}
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {groups.length === 0 && (
          <div className="rounded-md bg-selected px-2 py-1.5 text-[13px] text-foreground">Current session</div>
        )}
        {groups.map(([ws, sess]) => {
          const wsName = ws.split('/').filter(Boolean).pop() ?? ws
          const collapsed = collapsedGroups.has(ws)
          return (
            <div key={ws} className="flex flex-col">
              <div
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest transition-colors hover:bg-surface-hover"
                onClick={() => setCollapsedGroups((prev) => {
                  const next = new Set(prev)
                  if (next.has(ws)) next.delete(ws)
                  else next.add(ws)
                  return next
                })}
              >
                <span className={`text-[8px] transition-transform ${collapsed ? '' : 'rotate-90'}`}>▸</span>
                <span className="flex-1 truncate">{wsName}</span>
                <span className="text-[10px] opacity-60">{sess.length}</span>
              </div>
              {!collapsed && sess.map((s) => (
                <SessionRow
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  isActive={s.id === props.activeSession}
                  isEditing={editing === s.id}
                  draft={draft}
                  onSelect={() => props.onSelectSession(s.id)}
                  onRename={() => { setEditing(s.id); setDraft(s.title) }}
                  onFork={() => props.onForkSession(s.id)}
                  onDelete={() => props.onDeleteSession(s.id)}
                  onDraftChange={setDraft}
                  onCommitRename={() => commitRename(s.id)}
                  onCancelRename={() => setEditing(null)}
                />
              ))}
            </div>
          )
        })}

        {/* Workflows */}
        {props.workflows.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">Workflows</div>
            {props.workflows.map((w) => (
              <div
                key={w.id}
                className={`group flex cursor-pointer items-center rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                  w.id === props.activeWorkflow ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'
                }`}
                onClick={() => props.onOpenWorkflow(w.id)}
                title={w.title}
              >
                <span className="flex-1 truncate">{w.title}</span>
                <span className={`rounded-full border border-border px-1.5 py-0.5 text-[9px] ${w.status === 'done' ? 'text-foreground' : 'text-foreground-subtlest'}`}>
                  {w.done}/{w.total}
                </span>
                <button
                  className="shrink-0 rounded p-0.5 text-[11px] text-foreground-subtlest opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  title="Delete workflow"
                  onClick={(e) => { e.stopPropagation(); props.onDeleteWorkflow(w.id) }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Skills */}
        {props.skills.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">Skills</div>
            {props.skills.map((s) => (
              <div
                key={s.name}
                className="flex cursor-pointer items-center rounded-md px-2 py-1.5 text-[13px] text-foreground-subtle transition-colors hover:bg-surface-hover"
                onClick={() => props.onToggleSkill(s.name, !s.enabled)}
                title={s.description}
              >
                <span className={`flex-1 truncate ${s.enabled ? '' : 'opacity-40'}`}>{s.name}</span>
                <span className={`shrink-0 text-[10px] ${s.enabled ? 'text-foreground' : 'text-foreground-subtlest'}`}>
                  {s.enabled ? '●' : '○'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto flex flex-col gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="flex items-center gap-1 px-1">
          <button
            className="rounded-md p-1.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
            onClick={props.onRemote}
            title="Connect to a remote environment"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M7 10l3 2.5L7 15M12.5 15H16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
          <button
            className="rounded-md p-1.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
            onClick={props.onSettings}
            title="Settings"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`size-4 rounded-full border transition-transform ${props.theme === t.id ? 'border-foreground ring-1 ring-foreground/30' : 'border-border'}`}
              style={{ background: t.dot }}
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
