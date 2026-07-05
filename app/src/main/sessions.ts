// Session persistence — restarts restore your work. Sessions live as JSON in
// userData (no cloud, no telemetry): the transcript for display, plus the
// backend-opaque history so a conversation can continue across launches.
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../shared/types'

const file = (): string => join(app.getPath('userData'), 'grasp-sessions.json')
const CAP = 100 // keep the newest N sessions

function readAll(): SessionRecord[] {
  try {
    if (existsSync(file())) return JSON.parse(readFileSync(file(), 'utf-8')) as SessionRecord[]
  } catch {
    /* corrupt store -> start empty rather than crash */
  }
  return []
}

function writeAll(sessions: SessionRecord[]): void {
  writeFileSync(file(), JSON.stringify(sessions), { mode: 0o600 })
}

export function listSessions(): SessionRecord[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveSession(rec: SessionRecord): void {
  const all = readAll().filter((s) => s.id !== rec.id)
  all.push(rec)
  writeAll(all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CAP))
}

export function deleteSession(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id))
}

// Fork a session: copy its transcript + backend-opaque history to a NEW session (new id),
// linked back to the original via parentId (provenance). The fork continues independently.
export function forkSession(id: string): string {
  const src = readAll().find((s) => s.id === id)
  if (!src) return ''
  const fork: SessionRecord = {
    ...src,
    id: randomUUID(),
    title: src.title + ' (fork)',
    parentId: src.id,
    updatedAt: Date.now()
  }
  saveSession(fork)
  return fork.id
}

// Rename a session; marks titleUserSet so the autosave keeps the user's title instead of
// re-deriving it from the first message.
export function renameSession(id: string, title: string): void {
  const all = readAll()
  const s = all.find((x) => x.id === id)
  if (!s) return
  s.title = title.trim().slice(0, 120) || s.title
  s.titleUserSet = true
  s.updatedAt = Date.now()
  writeAll(all)
}
