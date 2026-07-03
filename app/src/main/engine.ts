// The seam to grasp's observation engine (the differentiator). We shell the Python
// engine's skill and get the graph contract back. This is the one thing the agent
// cannot fake — a real execution, observed.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ObserveParams, ObserveResult } from '../shared/types'

// Engine lives at repo-root/engine (this file bundles to app/out/main). Override with env.
const ENGINE = process.env.GRASP_ENGINE ?? resolve(process.cwd(), '..', 'engine')
const PY = process.env.GRASP_PY ?? join(ENGINE, '.venv', 'bin', 'python')

export function observe(params: ObserveParams): Promise<ObserveResult> {
  return new Promise((res) => {
    if (!existsSync(PY)) {
      return res({ ok: false, observed: false, error: `engine python not found at ${PY}. Run: cd engine && make venv` })
    }
    const args = ['-m', 'dreplay.skill', 'observe', '--repo', params.repo || '.', '--entrypoint', params.entrypoint]
    if (params.input) args.push('--input', params.input)
    const cp = spawn(PY, args, { cwd: ENGINE })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => res({ ok: false, observed: false, error: e.message }))
    cp.on('close', () => {
      try {
        const r = JSON.parse(out)
        res({ ok: !!r.ok, observed: !!r.observed, graph: r.graph, error: r.error ?? null })
      } catch {
        res({ ok: false, observed: false, error: err.trim() || 'engine returned no JSON' })
      }
    })
  })
}
