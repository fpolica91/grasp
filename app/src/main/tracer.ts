// The tracer bridge — runs a native reference tracer and returns a validated Trace v1
// doc. These tracers are skill ASSETS the agent invokes (grasp ships them for the
// common stacks so the agent doesn't reinvent tracing), NOT a grasp engine: they use
// the target's own runtime. Honesty: any failure to run the tracer becomes an
// `unobservable` trace, never a fabricated frame.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TraceDoc } from '../shared/trace'

// dev: app/resources/tracers ; packaged: resources/tracers next to the asar (extraResources)
function tracerDir(): string {
  const dev = resolve(process.cwd(), 'resources', 'tracers')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath ?? process.cwd(), 'tracers')
}

function unobservable(entry: string, language: string, reason: string, hint?: string): TraceDoc {
  return {
    grasp_trace_version: '1',
    id: randomUUID(),
    createdAt: Date.now(),
    entry,
    language,
    how: 'tracer could not run',
    gitRef: null,
    input: null,
    status: 'unobservable',
    frames: [],
    ret: null,
    threw: null,
    durationMs: null,
    stdout: '',
    stderr: '',
    unobservable: { reason, ...(hint ? { hint } : {}) }
  }
}

const PY = process.env.GRASP_PY ?? 'python3'

// Trace a Python entrypoint by running the settrace reference tracer against the repo.
export function tracePython(workspace: string, entry: string, input: Record<string, unknown>): Promise<TraceDoc> {
  return new Promise((res) => {
    const script = join(tracerDir(), 'py_trace.py')
    if (!existsSync(script)) return res(unobservable(entry, 'python', `tracer not found at ${script}`))
    const cp = spawn(PY, [script, '--repo', workspace || '.', '--entry', entry, '--input', JSON.stringify(input ?? {})], {
      cwd: workspace || process.cwd()
    })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => res(unobservable(entry, 'python', `could not start python tracer: ${e.message}`)))
    cp.on('close', () => {
      try {
        const doc = JSON.parse(out.trim().split('\n').pop() || '{}') as TraceDoc
        doc.createdAt = Date.now()
        res(doc)
      } catch {
        res(unobservable(entry, 'python', err.trim() || 'tracer produced no trace JSON'))
      }
    })
  })
}

// Language dispatch. JS/TS land in step 4 (V8 inspector); until then, honest unobservable.
export function runTrace(
  workspace: string,
  entry: string,
  input: Record<string, unknown>,
  language: string
): Promise<TraceDoc> {
  if (language === 'py' || language === 'python') return tracePython(workspace, entry, input)
  return Promise.resolve(
    unobservable(entry, language, `no native tracer wired for ${language} yet`, 'Python is traced now; JS/TS via the V8 inspector is next.')
  )
}
