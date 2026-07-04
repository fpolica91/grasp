// The project switcher — a pill in the sidebar foot showing the active project, opening a
// popover of recent projects + Open folder (native dialog) + New project (under
// ~/GraspProjects). Switching sets the agent's workspace.
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
    <div className="proj" ref={ref}>
      <button className="proj-pill" onClick={() => setOpen((o) => !o)} title={workspace}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.7" /></svg>
        <span className="proj-name">{base(workspace) || 'no project'}</span>
        <span className="proj-caret">▾</span>
      </button>
      {open && (
        <div className="proj-pop">
          {recent.length > 0 && <div className="proj-sec">Recent</div>}
          {recent.map((p) => (
            <button key={p.path} className={`proj-item${p.path === workspace ? ' on' : ''}`} onClick={() => pick(p.path)} title={p.path}>
              <span className="proj-item-name">{p.name}</span>
              {p.path === workspace && <span className="proj-check">✓</span>}
            </button>
          ))}
          <div className="proj-div" />
          {creating ? (
            <div className="proj-new">
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
              />
              <button className="btn sm primary" onClick={() => void create()} disabled={!name.trim()}>
                Create
              </button>
            </div>
          ) : (
            <button className="proj-item action" onClick={() => setCreating(true)}>
              ＋ New project
            </button>
          )}
          <button className="proj-item action" onClick={() => void openFolder()}>
            ⊞ Open folder…
          </button>
        </div>
      )}
    </div>
  )
}
