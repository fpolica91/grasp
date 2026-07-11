// The project switcher — a pill in the sidebar foot showing the active project, opening a
// popover of recent projects + Open folder (native dialog) + New project (under
// ~/GraspProjects). Switching sets the agent's workspace.
// Migrated to Tailwind v4 utilities matching ZCode's aesthetic.
import { useEffect, useRef, useState } from 'react'

const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

export function ProjectSwitcher({ workspace, onSwitch }: { workspace: string; onSwitch: (path: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<{ path: string; name: string }[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) void window.grasp.projects().then(setRecent)
  }, [open])
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (path: string): void => {
    if (path) onSwitch(path)
    setOpen(false)
    setCreating(false)
  }
  const openFolder = async (): Promise<void> => {
    const p = await window.grasp.openFolder()
    if (p) pick(p)
  }
  const create = async (): Promise<void> => {
    const r = await window.grasp.newProject(name)
    if (r.ok && r.path) {
      setName('')
      pick(r.path)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-input px-2.5 py-2 text-[0.8125rem] text-foreground-subtle transition-colors hover:bg-surface-hover"
        onClick={() => setOpen((o) => !o)}
        title={workspace}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.7" /></svg>
        <span className="flex-1 truncate text-left">{base(workspace) || 'no project'}</span>
        <span className="text-[0.625rem] text-foreground-subtlest">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 flex w-full min-w-[200px] flex-col gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-xl">
          {recent.length > 0 && (
            <div className="px-2.5 py-1 text-[0.625rem] font-medium uppercase tracking-wide text-foreground-subtlest">Recent</div>
          )}
          {recent.map((p) => (
            <button
              key={p.path}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[0.8125rem] transition-colors ${
                p.path === workspace ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'
              }`}
              onClick={() => pick(p.path)}
              title={p.path}
            >
              <span className="flex-1 truncate text-left">{p.name}</span>
              {p.path === workspace && <span className="text-foreground-subtlest">✓</span>}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          {creating ? (
            <div className="flex items-center gap-1.5 p-1">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create()
                  if (e.key === 'Escape') setCreating(false)
                }}
                placeholder="new-project-name"
                spellCheck={false}
                className="flex-1 rounded-md border border-border bg-input px-2.5 py-1.5 text-[0.8125rem] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-border-hover"
              />
              <button
                className="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] font-medium text-primary-foreground disabled:opacity-50"
                onClick={() => void create()}
                disabled={!name.trim()}
              >
                Create
              </button>
            </div>
          ) : (
            <button
              className="flex items-center rounded-md px-2.5 py-1.5 text-[0.8125rem] text-foreground-subtle transition-colors hover:bg-surface-hover"
              onClick={() => setCreating(true)}
            >
              ＋ New project
            </button>
          )}
          <button
            className="flex items-center rounded-md px-2.5 py-1.5 text-[0.8125rem] text-foreground-subtle transition-colors hover:bg-surface-hover"
            onClick={() => void openFolder()}
          >
            ⊞ Open folder…
          </button>
        </div>
      )}
    </div>
  )
}
