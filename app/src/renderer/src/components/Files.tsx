// The editor pane: a workspace file tree + a multi-file editor with tabs and split view.
// Each open file is a tab; the editor can split side-by-side. CodeMirror with ZCode theme.
// Migrated to Tailwind v4 utilities.
import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { MergeView } from '@codemirror/merge'
import { Decoration, WidgetType, gutter, GutterMarker } from '@codemirror/view'
import type { TreeNode } from '../../../shared/types'
import type { WalkAnchor } from './FlowWalk'

const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

function langFor(path: string): Extension {
  if (path.endsWith('.py')) return python()
  if (/\.(jsx|tsx|ts|js|mjs|cjs)$/.test(path)) return javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) })
  return []
}

// Zed-inspired syntax palette (One Dark — the theme Zed ships) mapped to lezer tags.
// Purple keywords, green strings, blue functions, yellow types, orange numbers,
// red properties — the signature Zed look, shared with the terminal/code blocks.
const graspHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#7f848e', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.modifier, t.self], color: '#c678dd' },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator], color: '#56b6c2' },
  { tag: [t.atom, t.bool, t.null], color: '#d19a66' },
  { tag: [t.number, t.literal, t.unit], color: '#d19a66' },
  { tag: [t.string, t.special(t.string)], color: '#98c379' },
  { tag: t.escape, color: '#56b6c2' },
  { tag: t.regexp, color: '#98c379' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: '#61afef' },
  { tag: [t.typeName, t.className, t.definition(t.typeName), t.namespace], color: '#e5c07b' },
  { tag: [t.propertyName, t.constant(t.propertyName)], color: '#e06c75' },
  { tag: [t.attributeName, t.attributeValue], color: '#d19a66' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#e6e6e6' },
  { tag: [t.local(t.variableName)], color: '#e6e6e6' },
  { tag: [t.labelName, t.heading], color: '#e06c75' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#abb2bf' },
  { tag: t.meta, color: '#abb2bf' },
  { tag: t.invalid, color: '#ff5c5c' },
  { tag: t.link, color: '#61afef', textDecoration: 'underline' }
])

const graspTheme = EditorView.theme(
  {
    // canvas: a deep, dedicated editor background so code reads as the primary surface
    '&': { color: '#abb2bf', backgroundColor: '#161616', fontSize: '13px', height: '100%' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace", lineHeight: '1.65', fontVariantLigatures: 'contextual', fontFeatureSettings: "'liga' 1, 'calt' 1" },
    '.cm-content': { caretColor: '#528bff', padding: '8px 0' },
    // gutter — Zed-like: dim numbers, brighter on the active line, no separator border
    '.cm-gutters': { backgroundColor: '#161616', color: '#4b5263', border: 'none', paddingRight: '6px' },
    '.cm-gutter.cm-lineNumbers': { minWidth: '2.5em' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#abb2bf' },
    // active line — a whisper of highlight
    '.cm-activeLine': { backgroundColor: '#ffffff06' },
    // selection — Zed's blue translucent
    '.cm-selectionBackground, ::selection': { backgroundColor: '#2b6cb0 !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: '#3b6ea5 !important' },
    '::selection': { backgroundColor: '#3b6ea5' },
    // Zed's signature blue cursor
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#528bff', borderLeftWidth: '2px' },
    // matching brackets
    '.cm-matchingBracket': { backgroundColor: '#3b4252', color: '#ffffff !important', outline: '1px solid #61afef66' },
    '.cm-nonmatchingBracket': { backgroundColor: '#432b34', color: '#ff5c5c !important' },
    // whitespace + indentation guides (shown by indentUnit/foldGutter)
    '.cm-indent': { borderLeftColor: '#ffffff0d' },
    // search panel
    '.cm-panels': { backgroundColor: '#1c1d23', color: '#abb2bf', borderTop: '1px solid #ffffff14' },
    '.cm-panels input': { backgroundColor: '#22232a', border: '1px solid #ffffff1a', color: '#e6e6e6' },
    '.cm-searchMatch': { backgroundColor: '#3d4050' },
    '.cm-searchMatch-selected': { backgroundColor: '#528bff66' },
    // tooltips / autocomplete
    '.cm-tooltip': { backgroundColor: '#1c1d23', border: '1px solid #ffffff1a', color: '#abb2bf' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#528bff33', color: '#ffffff' }
  },
  { dark: true }
)

// ——— Flow-walk editor decorations: numbered anchor chips in the gutter + the inline
// tour pill above the current anchor's line. Values shown are the trace's observed
// reprs; the pill walks the meaningful frames (prev/next), across files.
class WalkChipMarker extends GutterMarker {
  constructor(private n: number, private current: boolean) { super() }
  eq(o: WalkChipMarker): boolean { return o.n === this.n && o.current === this.current }
  toDOM(): Node {
    const s = document.createElement('span')
    s.className = 'cm-walk-chip' + (this.current ? ' cm-walk-chip-current' : '')
    s.textContent = String(this.n)
    return s
  }
}

class TourPillWidget extends WidgetType {
  constructor(private a: WalkAnchor, private total: number, private onTour: (ix: number) => void) { super() }
  eq(o: TourPillWidget): boolean { return o.a.n === this.a.n && o.total === this.total }
  ignoreEvent(): boolean { return true }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-walk-pill'
    const n = document.createElement('span'); n.className = 'cm-walk-pill-n'; n.textContent = String(this.a.n)
    const fn = document.createElement('span'); fn.className = 'cm-walk-pill-fn'; fn.textContent = this.a.fn
    const f = this.a.frame
    const vals = document.createElement('span'); vals.className = 'cm-walk-pill-vals'
    const args = f.args.map((x) => (x.repr.length > 24 ? x.repr.slice(0, 23) + '…' : x.repr)).join(', ')
    const out = f.threw ? `threw ${f.threw.type}` : f.ret ? `→ ${f.ret.repr.slice(0, 36)}` : '→ ∅'
    vals.textContent = `(${args}) ${out}`.slice(0, 100)
    const nav = document.createElement('span'); nav.className = 'cm-walk-pill-nav'
    const mk = (label: string, ix: number, ok: boolean): HTMLButtonElement => {
      const b = document.createElement('button')
      b.textContent = label
      b.disabled = !ok
      b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.onTour(ix) })
      return b
    }
    nav.append(mk('‹', this.a.n - 2, this.a.n > 1), document.createTextNode(`${this.a.n}/${this.total}`), mk('›', this.a.n, this.a.n < this.total))
    el.append(n, fn, vals, nav)
    return el
  }
}

interface EditorWalk { anchors: WalkAnchor[]; currentIx: number | null; total: number; onTour: (ix: number) => void }

function walkExtensions(doc: Text, walk: EditorWalk | undefined): Extension {
  if (!walk || !walk.anchors.length) return []
  const here = walk.anchors.filter((a) => a.line !== null && a.line >= 1 && a.line <= doc.lines)
  if (!here.length) return []
  const currentN = walk.currentIx !== null ? walk.currentIx + 1 : null
  const g = gutter({
    class: 'cm-walk-gutterCol',
    lineMarker: (view, block) => {
      const ln = view.state.doc.lineAt(block.from).number
      const a = here.find((x) => x.line === ln)
      return a ? new WalkChipMarker(a.n, a.n === currentN) : null
    }
  })
  const cur = currentN !== null ? here.find((a) => a.n === currentN) : undefined
  if (!cur || cur.line === null) return [g]
  const deco = Decoration.widget({ widget: new TourPillWidget(cur, walk.total, walk.onTour), block: true, side: -1 })
  return [g, EditorView.decorations.of(Decoration.set([deco.range(doc.line(cur.line).from)]))]
}

function Editor({ workspace, file, reveal, walk }: { workspace: string; file: string; reveal?: { line: number | null; nonce: number }; walk?: EditorWalk }): React.JSX.Element {
  const [mode, setMode] = useState<'edit' | 'diff'>('edit')
  const [dirty, setDirty] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | MergeView | null>(null)
  const docRef = useRef('')
  const [walkComp] = useState(() => new Compartment())
  const revealRef = useRef(reveal)
  revealRef.current = reveal
  const walkRef = useRef(walk)
  walkRef.current = walk
  const applyReveal = (v: EditorView): void => {
    const r = revealRef.current
    if (!r) return
    const ln = Math.max(1, Math.min(r.line ?? 1, v.state.doc.lines))
    const pos = v.state.doc.line(ln).from
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const build = async (): Promise<void> => {
      if (mode === 'diff') {
        const d = await window.grasp.fileDiff(workspace, file)
        if (disposed) return
        host.innerHTML = ''
        viewRef.current = new MergeView({
          parent: host,
          a: { doc: d.old, extensions: [basicSetup, langFor(file), syntaxHighlighting(graspHighlight), graspTheme, EditorState.readOnly.of(true)] },
          b: { doc: d.new, extensions: [basicSetup, langFor(file), syntaxHighlighting(graspHighlight), graspTheme, EditorState.readOnly.of(true)] }
        })
      } else {
        const r = await window.grasp.readFile(workspace, file)
        if (disposed) return
        docRef.current = r.content ?? ''
        setDirty(false)
        host.innerHTML = ''
        const v = new EditorView({
          parent: host,
          doc: docRef.current,
          extensions: [basicSetup, langFor(file), syntaxHighlighting(graspHighlight), graspTheme, walkComp.of([]), EditorView.updateListener.of((u) => {
            if (u.docChanged) { docRef.current = u.state.doc.toString(); setDirty(true) }
          })]
        })
        viewRef.current = v
        v.dispatch({ effects: walkComp.reconfigure(walkExtensions(v.state.doc, walkRef.current)) })
        applyReveal(v)
      }
    }
    void build()
    return () => { disposed = true; viewRef.current?.destroy(); viewRef.current = null }
  }, [file, mode, workspace])

  // Walk decorations follow the anchors/current-step live (compartment reconfigure —
  // no rebuild, no scroll loss).
  useEffect(() => {
    const v = viewRef.current
    if (mode !== 'edit' || !v || !(v instanceof EditorView)) return
    v.dispatch({ effects: walkComp.reconfigure(walkExtensions(v.state.doc, walk)) })
  }, [walk, mode, walkComp])
  useEffect(() => {
    const v = viewRef.current
    if (!reveal || mode !== 'edit' || !v || !(v instanceof EditorView)) return
    applyReveal(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce])

  const save = async (): Promise<void> => {
    await window.grasp.writeFile(workspace, file, docRef.current)
    setDirty(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && hostRef.current?.contains(document.activeElement)) {
        e.preventDefault(); void save()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-[12px] text-foreground-subtle">{file}</span>
        <span className="ml-auto flex items-center rounded-md bg-tag p-0.5 text-[11px]">
          <button className={`rounded px-2 py-0.5 transition-colors ${mode === 'edit' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => setMode('edit')}>Edit</button>
          <button className={`rounded px-2 py-0.5 transition-colors ${mode === 'diff' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => setMode('diff')}>Diff</button>
        </span>
        {mode === 'edit' && (
          <button
            className="rounded-md border border-border bg-secondary px-2.5 py-1 text-[12px] font-medium text-foreground transition-filter hover:brightness-110 disabled:opacity-40"
            disabled={!dirty}
            onClick={() => void save()}
          >
            {dirty ? 'Save' : 'Saved'}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" ref={hostRef} />
    </div>
  )
}

function EditorGroup(props: {
  workspace: string; open: string[]; active: string
  onActivate: (f: string) => void; onClose: (f: string) => void; right?: React.ReactNode
  reveal?: { file: string; line: number | null; nonce: number } | null
  walkFor?: (f: string) => EditorWalk | undefined
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center border-b border-border">
        {props.open.map((f) => (
          <div
            key={f}
            className={`group flex cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-[12px] transition-colors ${f === props.active ? 'bg-background text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`}
            onClick={() => props.onActivate(f)}
            title={f}
          >
            <span className="truncate">{base(f)}</span>
            <button
              className="rounded p-0.5 text-[10px] text-foreground-subtlest opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); props.onClose(f) }}
            >
              ✕
            </button>
          </div>
        ))}
        <span className="ml-auto pr-2">{props.right}</span>
      </div>
      {props.active && (
        <Editor
          key={props.active}
          workspace={props.workspace}
          file={props.active}
          reveal={props.reveal && props.reveal.file === props.active ? { line: props.reveal.line, nonce: props.reveal.nonce } : undefined}
          walk={props.walkFor?.(props.active)}
        />
      )}
    </div>
  )
}

function Tree({ nodes, selected, onOpen }: { nodes: TreeNode[]; selected: string; onOpen: (p: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string): void => setOpen((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p)))
  const render = (list: TreeNode[], depth: number): React.JSX.Element[] =>
    list.flatMap((n) => {
      const pad = { paddingLeft: `${8 + depth * 13}px` }
      if (n.dir) {
        const isOpen = open.has(n.path)
        return [
          <div key={n.path} className="flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-[13px] text-foreground-subtle transition-colors hover:bg-surface-hover" style={pad} onClick={() => toggle(n.path)}>
            <span className={`text-[8px] transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
            {n.name}
          </div>,
          ...(isOpen && n.children ? render(n.children, depth + 1) : [])
        ]
      }
      return [
        <div
          key={n.path}
          className={`cursor-pointer rounded-md py-0.5 text-[13px] transition-colors ${selected === n.path ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`}
          style={pad}
          onClick={() => onOpen(n.path)}
        >
          {n.name}
        </div>
      ]
    })
  return <div className="flex flex-col gap-px py-1">{render(nodes, 0)}</div>
}

export function FilesPane({ workspace, active, walk }: { workspace: string; active: boolean; walk?: { anchors: WalkAnchor[]; currentIx: number | null; onTour: (ix: number) => void } }): React.JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [open, setOpen] = useState<string[]>([])
  const [left, setLeft] = useState('')
  const [rightFile, setRightFile] = useState<string | null>(null)

  const loadTree = (): void => {
    if (workspace) void window.grasp.listTree(workspace).then(setTree)
  }
  useEffect(() => {
    if (active) loadTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspace])

  const openFile = (p: string): void => {
    setOpen((o) => (o.includes(p) ? o : [...o, p]))
    setLeft(p)
  }
  const [reveal, setReveal] = useState<{ file: string; line: number | null; nonce: number } | null>(null)
  // The open-at-line bridge: FlowView / the Walk / anything else dispatches
  // 'grasp:open-source' {file, line}; every mounted FilesPane opens the file and
  // reveals the line — so the jump works in whichever persona is showing.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent).detail as { file?: unknown; line?: unknown } | undefined
      if (!d || typeof d.file !== 'string') return
      openFile(d.file)
      setReveal({ file: d.file, line: typeof d.line === 'number' ? d.line : null, nonce: Date.now() })
    }
    window.addEventListener('grasp:open-source', onOpen)
    return () => window.removeEventListener('grasp:open-source', onOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const editorWalk = (f: string): EditorWalk | undefined =>
    walk && walk.anchors.length
      ? { anchors: walk.anchors.filter((a) => a.file === f), currentIx: walk.currentIx, total: walk.anchors.length, onTour: walk.onTour }
      : undefined
  const closeFile = (p: string): void => {
    setOpen((o) => {
      const next = o.filter((x) => x !== p)
      if (left === p) setLeft(next[next.length - 1] ?? '')
      if (rightFile === p) setRightFile(next.length ? (next[0] === p ? next[1] ?? null : next[0]) : null)
      return next
    })
  }

  return (
    <div className="flex h-full">
      {/* File tree */}
      <div className="flex w-[200px] shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtlest">files</span>
          <button
            className="ml-auto flex size-5 items-center justify-center rounded text-[11px] text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
            onClick={loadTree}
            title="refresh"
          >
            ↻
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
          <Tree nodes={tree} selected={left} onOpen={openFile} />
        </div>
      </div>
      {/* Editors */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {rightFile === null ? (
          <EditorGroup
            workspace={workspace} open={open} active={left} onActivate={setLeft} onClose={closeFile}
            reveal={reveal} walkFor={editorWalk}
            right={open.length > 0 && (
              <button
                className="flex size-5 items-center justify-center rounded text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
                onClick={() => setRightFile(left || open[0])}
                title="Split editor right"
              >⊟</button>
            )}
          />
        ) : (
          <PanelGroup direction="horizontal" autoSaveId="grasp-editors">
            <Panel minSize={20}>
              <EditorGroup workspace={workspace} open={open} active={left} onActivate={setLeft} onClose={closeFile} reveal={reveal} walkFor={editorWalk} />
            </Panel>
            <PanelResizeHandle className="w-px shrink-0 bg-border" />
            <Panel minSize={20}>
              <EditorGroup
                workspace={workspace} open={open} active={rightFile} onActivate={setRightFile} onClose={closeFile}
                reveal={reveal} walkFor={editorWalk}
                right={
                  <button
                    className="flex size-5 items-center justify-center rounded text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
                    onClick={() => setRightFile(null)}
                    title="Close split"
                  >✕</button>
                }
              />
            </Panel>
          </PanelGroup>
        )}
        {open.length === 0 && (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-foreground-subtlest">
            Pick a file from the tree to open it. Open several — they become tabs — and split the editor with ⊟.
          </div>
        )}
      </div>
    </div>
  )
}
