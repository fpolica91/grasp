// The editor pane: a workspace file tree, a CodeMirror editor to view/edit files, and a
// text diff (git HEAD vs working tree) that sits alongside grasp's behavioral dataflow
// diff. CodeMirror (not Monaco) because it bundles cleanly in Vite/Electron with no
// worker/CSP gymnastics — same substance, none of the integration risk.
import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { MergeView } from '@codemirror/merge'
import type { TreeNode } from '../../../shared/types'

function langFor(path: string): Extension {
  if (path.endsWith('.py')) return python()
  if (/\.(jsx|tsx|ts|js|mjs|cjs)$/.test(path)) return javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) })
  return []
}

// A compact dark theme matching grasp's tokens.
const graspTheme = EditorView.theme(
  {
    '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: '12.5px', height: '100%' },
    '.cm-content': { fontFamily: "'Geist Mono', ui-monospace, monospace", caretColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-bg) !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-bg) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' }
  },
  { dark: true }
)

function Tree({
  nodes,
  selected,
  onOpen
}: {
  nodes: TreeNode[]
  selected: string
  onOpen: (p: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string): void => setOpen((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p)))
  const render = (list: TreeNode[], depth: number): React.JSX.Element[] =>
    list.flatMap((n) => {
      const pad = { paddingLeft: 8 + depth * 13 }
      if (n.dir) {
        const isOpen = open.has(n.path)
        return [
          <div key={n.path} className="tree-row dir" style={pad} onClick={() => toggle(n.path)}>
            <span className={`tri${isOpen ? ' open' : ''}`}>▸</span>
            {n.name}
          </div>,
          ...(isOpen && n.children ? render(n.children, depth + 1) : [])
        ]
      }
      return [
        <div
          key={n.path}
          className={`tree-row file${selected === n.path ? ' sel' : ''}`}
          style={pad}
          onClick={() => onOpen(n.path)}
        >
          {n.name}
        </div>
      ]
    })
  return <div className="tree">{render(nodes, 0)}</div>
}

export function FilesPane({ workspace, active }: { workspace: string; active: boolean }): React.JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [selected, setSelected] = useState('')
  const [mode, setMode] = useState<'edit' | 'diff'>('edit')
  const [dirty, setDirty] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | MergeView | null>(null)
  const docRef = useRef('')

  const loadTree = (): void => {
    if (workspace) void window.grasp.listTree(workspace).then(setTree)
  }
  useEffect(() => {
    if (active) loadTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspace])

  // Build the editor / diff view whenever the file or mode changes.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !selected) return
    let disposed = false
    const build = async (): Promise<void> => {
      if (mode === 'diff') {
        const d = await window.grasp.fileDiff(workspace, selected)
        if (disposed) return
        host.innerHTML = ''
        viewRef.current = new MergeView({
          parent: host,
          a: { doc: d.old, extensions: [basicSetup, langFor(selected), graspTheme, EditorState.readOnly.of(true)] },
          b: { doc: d.new, extensions: [basicSetup, langFor(selected), graspTheme, EditorState.readOnly.of(true)] }
        })
      } else {
        const r = await window.grasp.readFile(workspace, selected)
        if (disposed) return
        docRef.current = r.content ?? ''
        host.innerHTML = ''
        viewRef.current = new EditorView({
          parent: host,
          doc: docRef.current,
          extensions: [
            basicSetup,
            langFor(selected),
            graspTheme,
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                docRef.current = u.state.doc.toString()
                setDirty(true)
              }
            })
          ]
        })
      }
    }
    void build()
    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [selected, mode, workspace])

  const openFile = (p: string): void => {
    setSelected(p)
    setMode('edit')
    setDirty(false)
  }
  const save = async (): Promise<void> => {
    if (!selected) return
    await window.grasp.writeFile(workspace, selected, docRef.current)
    setDirty(false)
  }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selected])

  return (
    <div className="files">
      <div className="files-tree">
        <div className="files-tree-head">
          <span className="eyebrow">files</span>
          <button className="mini" onClick={loadTree} title="refresh">
            ↻
          </button>
        </div>
        <Tree nodes={tree} selected={selected} onOpen={openFile} />
      </div>
      <div className="files-editor">
        <div className="files-bar">
          <span className="files-path">{selected || 'select a file'}</span>
          {selected && (
            <>
              <span className="mode-toggle sm">
                <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
                  Edit
                </button>
                <button className={mode === 'diff' ? 'on' : ''} onClick={() => setMode('diff')}>
                  Diff
                </button>
              </span>
              {mode === 'edit' && (
                <button className="btn sm" disabled={!dirty} onClick={() => void save()}>
                  {dirty ? 'Save' : 'Saved'}
                </button>
              )}
            </>
          )}
        </div>
        <div className="cm-host" ref={hostRef} />
        {!selected && <div className="files-empty">Pick a file from the tree to view or edit it. Diff shows HEAD vs your working tree.</div>}
      </div>
    </div>
  )
}
