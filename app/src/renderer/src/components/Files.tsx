// The editor pane: a workspace file tree + a multi-file editor with tabs and split view.
// Each open file is a tab; the editor can split side-by-side (two groups, independent
// active tabs). CodeMirror (not Monaco — clean Vite/Electron bundling). A file's Diff
// view (git HEAD vs working) sits alongside grasp's behavioral dataflow diff.
import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
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

// One file's editor: CodeMirror with an Edit/Diff toggle + save (Cmd/Ctrl+S when focused).
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
          a: { doc: d.old, extensions: [basicSetup, langFor(file), graspTheme, EditorState.readOnly.of(true)] },
          b: { doc: d.new, extensions: [basicSetup, langFor(file), graspTheme, EditorState.readOnly.of(true)] }
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
          extensions: [
            basicSetup,
            langFor(file),
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
  }, [file, mode, workspace])

  const save = async (): Promise<void> => {
    await window.grasp.writeFile(workspace, file, docRef.current)
    setDirty(false)
  }

  // Cmd/Ctrl+S saves whichever editor holds focus (works with split).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && hostRef.current?.contains(document.activeElement)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  return (
    <div className="editor">
      <div className="ed-bar">
        <span className="files-path">{file}</span>
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
      </div>
      <div className="cm-host" ref={hostRef} />
    </div>
  )
}

// A tabbed editor group: tabs of the open files, showing the active file's Editor.
function EditorGroup(props: {
  workspace: string
  open: string[]
  active: string
  onActivate: (f: string) => void
  onClose: (f: string) => void
  right?: React.ReactNode // toolbar action on the right (split / close-split)
}): React.JSX.Element {
  return (
    <div className="editor-group">
      <div className="ed-tabs">
        {props.open.map((f) => (
          <div
            key={f}
            className={`ed-tab${f === props.active ? ' on' : ''}`}
            onClick={() => props.onActivate(f)}
            title={f}
          >
            <span className="ed-tab-name">{base(f)}</span>
            <button
              className="ed-tab-x"
              onClick={(e) => {
                e.stopPropagation()
                props.onClose(f)
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <span className="ed-tabs-actions">{props.right}</span>
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
        <div key={n.path} className={`tree-row file${selected === n.path ? ' sel' : ''}`} style={pad} onClick={() => onOpen(n.path)}>
          {n.name}
        </div>
      ]
    })
  return <div className="tree">{render(nodes, 0)}</div>
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
    <div className="files">
      <div className="files-tree">
        <div className="files-tree-head">
          <span className="eyebrow">files</span>
          <button className="mini" onClick={loadTree} title="refresh">
            ↻
          </button>
        </div>
        <Tree nodes={tree} selected={left} onOpen={openFile} />
      </div>
      <div className="files-editors">
        {rightFile === null ? (
          <EditorGroup
            workspace={workspace}
            open={open}
            active={left}
            onActivate={setLeft}
            onClose={closeFile}
            right={
              open.length > 0 && (
                <button className="ed-action" onClick={() => setRightFile(left || open[0])} title="Split editor right">
                  ⊟
                </button>
              )
            }
          />
        ) : (
          <PanelGroup direction="horizontal" autoSaveId="grasp-editors">
            <Panel minSize={20}>
              <EditorGroup workspace={workspace} open={open} active={left} onActivate={setLeft} onClose={closeFile} />
            </Panel>
            <PanelResizeHandle className="rh rh-v" />
            <Panel minSize={20}>
              <EditorGroup
                workspace={workspace}
                open={open}
                active={rightFile}
                onActivate={setRightFile}
                onClose={closeFile}
                right={
                  <button className="ed-action" onClick={() => setRightFile(null)} title="Close split">
                    ✕
                  </button>
                }
              />
            </Panel>
          </PanelGroup>
        )}
        {open.length === 0 && (
          <div className="files-empty">Pick a file from the tree to open it. Open several — they become tabs — and split the editor with ⊟.</div>
        )}
      </div>
    </div>
  )
}
