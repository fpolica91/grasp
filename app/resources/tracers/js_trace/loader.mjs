// grasp ESM loader — resolves .ts/.tsx and Babel-instruments repo source on load, so a
// real Node execution of TS/JS produces an interior call tree. No temp files, no
// transpile-to-disk: the source is transformed in memory and Node runs the real module
// graph. Only files under GRASP_REPO are instrumented (deps run untouched).
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const babel = require('@babel/core')
const graspPlugin = require('./plugin.cjs')

const REPO = process.env.GRASP_REPO ? fileURLToPath(pathToFileURL(process.env.GRASP_REPO)) : ''
const TS_EXT = ['.ts', '.tsx', '.mts', '.cts']
const CANDIDATES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']

function underRepo(p) {
  return REPO && p.startsWith(REPO)
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // extensionless / .ts relative import that Node can't resolve — probe candidates
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const basePath = fileURLToPath(base)
      for (const ext of CANDIDATES) {
        const cand = basePath + ext
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, format: 'module', shortCircuit: true }
      }
    }
    throw err
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context)
  const path = fileURLToPath(url)
  const isTs = TS_EXT.some((e) => path.endsWith(e))
  const isJs = /\.(jsx|mjs|cjs|js)$/.test(path)
  // instrument only repo source (or any TS we must transpile anyway); deps pass through
  if (!isTs && !(isJs && underRepo(path))) return nextLoad(url, context)

  const source = readFileSync(path, 'utf-8')
  const result = babel.transformSync(source, {
    filename: path,
    sourceType: 'module',
    babelrc: false,
    configFile: false,
    presets: [
      [require('@babel/preset-typescript'), { allExtensions: true, isTSX: path.endsWith('x'), onlyRemoveTypeImports: true }],
      ...(path.endsWith('x') ? [[require('@babel/preset-react'), { runtime: 'automatic' }]] : [])
    ],
    plugins: underRepo(path) ? [graspPlugin] : [], // instrument repo files; only transpile deps' TS
    retainLines: true
  })
  return { format: 'module', source: result.code, shortCircuit: true }
}
