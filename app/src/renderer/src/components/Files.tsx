// The editor pane: a workspace file tree + a multi-file editor with tabs and split view.
// Each open file is a tab; the editor can split side-by-side. CodeMirror with ZCode theme.
// Migrated to Tailwind v4 utilities.
import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { MergeView } from '@codemirror/merge'
import type { TreeNode } from '../../../shared/types'

const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

function langFor(path: string): Extension {
  if (path.endsWith('.py')) return python()
  if (/\.(jsx|tsx|ts|js|mjs|cjs)$/.test(path)) return javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) })
  return []
}

// ZCode palette (.theme-zai-dark ANSI set) mapped to CodeMirror lezer tags —
// shares one scheme across editor, terminal, and code blocks.
const graspHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#d4d4d44d', fontStyle: 'italic' },
  { tag: t.keyword, color: '#7b5ce5' },
  { tag: [t.atom, t.bool, t.null], color: '#7b5ce5' },
  { tag: [t.number, t.literal], color: '#ff8a30' },
  { tag: t.string, color: '#46bf72' },
  { tag: t.regexp, color: '#46bf72' },
  { tag: [t.variableName, t.propertyName], color: '#d4d4d4' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#4099ff' },
  { tag: t.definition(t.function(t.variableName)), color: '#4099ff' },
  { tag: [t.typeName, t.className], color: '#42c8c8' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: '#ff8a30' },
  { tag: [t.heading, t.name], color: '#4099ff' },
  { tag: t.invalid, color: '#ff5c5c' },
  { tag: t.meta, color: '#87d9a4' }
])

const graspTheme = EditorView.theme(
  {
    '&': { color: '#d4d4d4', backgroundColor: 'transparent', fontSize: '12.5px', height: '100%' },
    '.cm-content': { fontFamily: 'ui-monospace, monospace', caretColor: '#f8f8f8' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#d4d4d44d', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#d4d4d499' },
    '.cm-selectionBackground, ::selection': { backgroundColor: '#4099ff47 !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: '#4099ff47 !important' },
    '.cm-cursor': { borderLeftColor: '#f8f8f8' },
    '.cm-matchingBracket': { backgroundColor: '#ffffff1a', outline: '1px solid #ffffff26' }
  },
  { dark: true }
)

function Editor({ workspace, file }: { workspace: string; file: string }): React.JSX.Element {
  const [mode, setMode] = useState<'edit' | 'diff'>('edit')
  const [dirty, setDirty] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | MergeView | null>(null)
  const docRef = useRef('')

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
        viewRef.current = new EditorView({
          parent: host,
          doc: docRef.current,
          extensions: [basicSetup, langFor(file), syntaxHighlighting(graspHighlight), graspTheme, EditorView.updateListener.of((u) => {
            if (u.docChanged) { docRef.current = u.state.doc.toString(); setDirty(true) }
          })]
        })
      }
    }
    void build()
    return () => { disposed = true; viewRef.current?.destroy(); viewRef.current = null }
  }, [file, mode, workspace])

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
      {props.active && <Editor key={props.active} workspace={props.workspace} file={props.active} />}
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

export function FilesPane({ workspace, active }: { workspace: string; active: boolean }): React.JSX.Element {
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
              <EditorGroup workspace={workspace} open={open} active={left} onActivate={setLeft} onClose={closeFile} />
            </Panel>
            <PanelResizeHandle className="w-px shrink-0 bg-border" />
            <Panel minSize={20}>
              <EditorGroup
                workspace={workspace} open={open} active={rightFile} onActivate={setRightFile} onClose={closeFile}
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
