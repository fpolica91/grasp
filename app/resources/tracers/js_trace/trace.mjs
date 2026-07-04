// grasp JS/TS reference tracer — runs a REAL execution of an entrypoint under the
// instrumenting loader and emits a Trace v1 document. A skill asset the agent invokes;
// uses the target's own Node runtime. Honesty: a load/resolve failure is `unobservable`,
// never a fabricated frame or a fake thrown-error.
//
//   node --import ./register.mjs trace.mjs --repo R --entry src/x.ts:func --input '{...}'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { resolve as pathResolve, isAbsolute, relative } from 'node:path'
import { existsSync } from 'node:fs'

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}
const repo = pathResolve(arg('--repo', '.'))
const entry = arg('--entry', '')
const inputRaw = arg('--input', '{}')

function rep(v) {
  if (typeof v === 'string') return `'${v}'`
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
  try {
    const s = JSON.stringify(v)
    return s.length > 400 ? s.slice(0, 400) + '…' : s
  } catch {
    return String(v)
  }
}
function jsonable(v) {
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return undefined
  }
}

const doc = {
  grasp_trace_version: '1',
  id: randomUUID(),
  createdAt: 0,
  entry,
  language: entry.endsWith('x') || /\.tsx?:/.test(entry) ? 'ts' : 'js',
  how: `Babel-instrumented run of ${entry}`,
  gitRef: null,
  input: {},
  status: 'unobservable',
  frames: [],
  ret: null,
  threw: null,
  durationMs: null,
  stdout: '',
  stderr: '',
  unobservable: null
}

function fail(reason, hint) {
  doc.status = 'unobservable'
  doc.unobservable = hint ? { reason, hint } : { reason }
  process.stdout.write(JSON.stringify(doc))
  process.exit(0)
}

// ── the collector the instrumented code calls ──────────────────────────────
const frames = []
const stack = []
let seq = 0
globalThis.__grasp = {
  enter(name, args, file, line) {
    seq++
    const rel = file && isAbsolute(file) && file.startsWith(repo) ? relative(repo, file) : file
    const rec = {
      id: 'f' + seq,
      parent: stack.length ? stack[stack.length - 1].id : null,
      seq,
      depth: stack.length,
      fn: name,
      file: rel,
      line,
      callLine: null,
      args: Object.entries(args || {}).map(([k, v]) => ({ name: k, repr: rep(v), json: jsonable(v) })),
      ret: null,
      threw: null,
      durMs: 0,
      language: doc.language,
      _t: performance.now()
    }
    stack.push(rec)
    frames.push(rec)
  },
  ret(v) {
    const r = stack[stack.length - 1]
    if (r) r.ret = { name: 'return', repr: rep(v), json: jsonable(v) }
    return v
  },
  thrown(e) {
    const r = stack[stack.length - 1]
    if (r) r.threw = { type: (e && e.name) || 'Error', message: rep(e && e.message !== undefined ? e.message : e) }
  },
  exit() {
    const r = stack.pop()
    if (r) {
      r.durMs = +(performance.now() - r._t).toFixed(3)
      delete r._t
    }
  }
}

// ── resolve the entrypoint: "path/file.ts:func" or "module.func" ───────────
let filePart, funcName
if (entry.includes(':')) {
  const ix = entry.lastIndexOf(':')
  filePart = entry.slice(0, ix)
  funcName = entry.slice(ix + 1)
} else {
  const ix = entry.lastIndexOf('.')
  filePart = entry.slice(0, ix)
  funcName = entry.slice(ix + 1)
}
let modPath = isAbsolute(filePart) ? filePart : pathResolve(repo, filePart)
if (!existsSync(modPath)) {
  const cand = ['.ts', '.tsx', '.js', '.jsx', '.mjs'].map((e) => modPath + e).find(existsSync)
  if (cand) modPath = cand
}
if (!existsSync(modPath)) fail(`entrypoint file not found: ${filePart}`, 'pass path/to/file.ts:functionName relative to the repo')

let input = {}
try {
  input = JSON.parse(inputRaw || '{}')
} catch {
  input = {}
}
doc.input = input

// bind JSON input keys to the function's declared parameter names (any key order); a
// single-param function whose param isn't a JSON key receives the whole input object.
function bindArgs(fn, obj) {
  const src = fn.toString()
  const m = src.match(/^[^(]*\(([^)]*)\)/s) || src.match(/^\s*(?:async\s*)?\(?([^)=]*)\)?\s*=>/s)
  const names = m ? m[1].split(',').map((s) => s.trim().split('=')[0].trim().replace(/[{}[\]]/g, '')).filter(Boolean) : []
  if (names.length === 0) return []
  if (names.length === 1 && !(names[0] in obj) && Object.keys(obj).length > 0) return [obj]
  return names.map((n) => obj[n])
}

const t0 = performance.now()
try {
  const mod = await import(pathToFileURL(modPath).href)
  const fn = mod[funcName] ?? (mod.default && mod.default[funcName])
  if (typeof fn !== 'function') fail(`export ${funcName} is not a function in ${filePart}`, 'check the exported name')
  const args = bindArgs(fn, input)
  let result
  try {
    result = await fn(...args)
    doc.status = 'returned'
    doc.ret = { name: 'return', repr: rep(result), json: jsonable(result) }
  } catch (e) {
    doc.status = 'threw'
    doc.threw = { type: (e && e.name) || 'Error', message: rep(e && e.message !== undefined ? e.message : e) }
  }
} catch (e) {
  // an import/module-load failure is a TOOLING fact, never the code's behavior
  fail(`could not load ${filePart}: ${(e && e.message) || e}`, 'the module or one of its imports failed to load in Node')
}

for (const f of frames) delete f._t
doc.frames = frames.sort((a, b) => a.seq - b.seq)
doc.durationMs = +(performance.now() - t0).toFixed(3)
process.stdout.write(JSON.stringify(doc))
