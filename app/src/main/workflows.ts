// Durable workflow persistence — a workflow's steps + progress + carried history live
// as JSON in userData, so a workflow interrupted by a restart resumes from its
// unfinished step. No cloud, no telemetry.
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowRecord } from '../shared/types'

const file = (): string => join(app.getPath('userData'), 'grasp-workflows.json')
const CAP = 100

function readAll(): WorkflowRecord[] {
  try {
    if (existsSync(file())) return JSON.parse(readFileSync(file(), 'utf-8')) as WorkflowRecord[]
  } catch {
    /* corrupt store -> start empty rather than crash */
  }
  return []
}

function writeAll(workflows: WorkflowRecord[]): void {
  writeFileSync(file(), JSON.stringify(workflows), { mode: 0o600 })
}

export function listWorkflows(): WorkflowRecord[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveWorkflow(rec: WorkflowRecord): void {
  const all = readAll().filter((w) => w.id !== rec.id)
  all.push(rec)
  writeAll(all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CAP))
}

export function deleteWorkflow(id: string): void {
  writeAll(readAll().filter((w) => w.id !== id))
}
