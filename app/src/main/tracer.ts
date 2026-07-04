// The tracer bridge — runs a native reference tracer and returns a validated Trace v1
// doc. These tracers are skill ASSETS the agent invokes (grasp ships them for the
// common stacks so the agent doesn't reinvent tracing), NOT a grasp engine: they use
// the target's own runtime. Honesty: any failure to run the tracer becomes an
// `unobservable` trace, never a fabricated frame.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { TraceDoc, TraceDiff } from '../shared/trace'
import { diffTraces } from '../shared/trace'

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


const NODE = process.env.GRASP_NODE ?? 'node'

// Trace a JS/TS entrypoint by running the Babel-instrumenting harness against the repo's
// real Node runtime. entry form: "src/file.ts:func". No transpile-to-temp; real module graph.
export function traceJs(workspace: string, entry: string, input: Record<string, unknown>, language: string): Promise<TraceDoc> {
  return new Promise((res) => {
    const dir = join(tracerDir(), 'js_trace')
    const harness = join(dir, 'trace.mjs')
    const register = join(dir, 'register.mjs')
    if (!existsSync(harness)) return res(unobservable(entry, language, `js tracer not found at ${harness}`))
    const cp = spawn(NODE, ['--import', register, harness, '--repo', workspace || '.', '--entry', entry, '--input', JSON.stringify(input ?? {})], {
      cwd: dir,
      env: { ...process.env, GRASP_REPO: workspace || process.cwd() }
    })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => res(unobservable(entry, language, `could not start node tracer: ${e.message}`)))
    cp.on('close', () => {
      try {
        const doc = JSON.parse(out.trim().split('\n').pop() || '{}') as TraceDoc
        doc.createdAt = Date.now()
        res(doc)
      } catch {
        res(unobservable(entry, language, err.trim().split('\n').slice(-3).join(' ') || 'js tracer produced no trace JSON'))
      }
    })
  })
}


const GO = process.env.GRASP_GO ?? 'go'

// Trace a Go entrypoint (path/file.go:Func) by running the AST-instrumenting orchestrator,
// which rewrites the target package and `go run`s it. No fake nodes; failures -> unobservable.
export function traceGo(workspace: string, entry: string, input: Record<string, unknown>): Promise<TraceDoc> {
  return new Promise((res) => {
    const dir = join(tracerDir(), 'go_trace')
    if (!existsSync(join(dir, 'go_trace.go'))) return res(unobservable(entry, 'go', `go tracer not found at ${dir}`))
    const cp = spawn(GO, ['run', '.', '--repo', workspace || '.', '--entry', entry, '--input', JSON.stringify(input ?? {})], {
      cwd: dir,
      env: { ...process.env }
    })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => res(unobservable(entry, 'go', `could not start go tracer: ${e.message}`)))
    cp.on('close', () => {
      try {
        const doc = JSON.parse(out.trim().split('\n').pop() || '{}') as TraceDoc
        doc.createdAt = Date.now()
        res(doc)
      } catch {
        res(unobservable(entry, 'go', err.trim().split('\n').slice(-3).join(' ') || 'go tracer produced no trace JSON'))
      }
    })
  })
}

// Language dispatch: python via settrace, js/ts via Babel harness, go via AST rewrite.
export function runTrace(
  workspace: string,
  entry: string,
  input: Record<string, unknown>,
  language: string
): Promise<TraceDoc> {
  if (language === 'py' || language === 'python') return tracePython(workspace, entry, input)
  if (language === 'js' || language === 'ts' || language === 'jsx' || language === 'tsx') return traceJs(workspace, entry, input, language)
  if (language === 'go') return traceGo(workspace, entry, input)
  return Promise.resolve(
    unobservable(entry, language, `no native tracer wired for ${language} yet`, 'Python, JS and TS are traced; other languages are next.')
  )
}


// Trace the same entry+input at a git ref (old) vs the working tree (new), and diff.
async function traceAtRef(workspace: string, ref: string, entry: string, input: Record<string, unknown>, lang: string): Promise<TraceDoc> {
  const wt = mkdtempSync(join(tmpdir(), 'grasp-wt-'))
  const add = spawnSync('git', ['-C', workspace, 'worktree', 'add', '--detach', wt, ref], { encoding: 'utf-8' })
  if (add.status !== 0) {
    try { rmSync(wt, { recursive: true, force: true }) } catch { /* ignore */ }
    return unobservable(entry, lang, `could not check out ${ref}: ${(add.stderr || '').trim()}`)
  }
  try {
    const t = await runTrace(wt, entry, input, lang)
    t.gitRef = ref
    return t
  } finally {
    spawnSync('git', ['-C', workspace, 'worktree', 'remove', '--force', wt])
    try { rmSync(wt, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export async function traceDiff(workspace: string, entry: string, input: Record<string, unknown>, oldRef: string, lang: string): Promise<{ diff: TraceDiff | null; error?: string }> {
  const oldT = await traceAtRef(workspace, oldRef, entry, input, lang)
  const newT = await runTrace(workspace, entry, input, lang)
  newT.gitRef = 'working tree'
  if (oldT.status === 'unobservable') return { diff: null, error: `old side (${oldRef}) unobservable: ${oldT.unobservable?.reason}` }
  if (newT.status === 'unobservable') return { diff: null, error: `new side unobservable: ${newT.unobservable?.reason}` }
  return { diff: diffTraces(oldT, newT) }
}

