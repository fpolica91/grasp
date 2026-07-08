// Projects — the folders the agent works in. New projects live under ~/GraspProjects
// (never grasp's own dir); Open folder picks any directory. The recent-projects list
// persists in userData so the switcher remembers where you've been.
import { app, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Project {
  path: string
  name: string
}

const store = (): string => join(app.getPath('userData'), 'grasp-projects.json')
export const projectsRoot = (): string => join(homedir(), 'GraspProjects')

function readRecent(): string[] {
  try {
    if (existsSync(store())) return JSON.parse(readFileSync(store(), 'utf-8')) as string[]
  } catch {
    /* corrupt -> empty */
  }
  return []
}
function writeRecent(paths: string[]): void {
  writeFileSync(store(), JSON.stringify(paths.slice(0, 30)), { mode: 0o600 })
}

const toProject = (p: string): Project => ({ path: p, name: p.split('/').filter(Boolean).pop() ?? p })

export function listProjects(): Project[] {
  return readRecent()
    .filter((p) => existsSync(p))
    .map(toProject)
}

export function rememberProject(path: string): void {
  if (!path) return
  writeRecent([path, ...readRecent().filter((p) => p !== path)])
}

// Native "open folder" dialog; returns the chosen path (remembered) or ''.
export async function openFolder(): Promise<string> {
  try {
    mkdirSync(projectsRoot(), { recursive: true })
  } catch {
    /* ignore */
  }
  const r = await dialog.showOpenDialog({
    title: 'Open project folder',
    defaultPath: projectsRoot(),
    properties: ['openDirectory', 'createDirectory']
  })
  const path = r.canceled ? '' : (r.filePaths[0] ?? '')
  if (path) rememberProject(path)
  return path
}

// Create a new project folder under ~/GraspProjects (sanitised name) and remember it.
export function newProject(name: string): { ok: boolean; path?: string; error?: string } {
  const clean = name.trim().replace(/[^\w.\- ]/g, '').replace(/\s+/g, '-')
  if (!clean) return { ok: false, error: 'empty name' }
  const path = join(projectsRoot(), clean)
  try {
    mkdirSync(path, { recursive: true })
    rememberProject(path)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
