// Codemap — a VISUAL map of the repo's real symbols (regex-extracted, not AI).
// Renders an interactive collapsible tree: dirs → files → symbols (color-coded by kind).
// Instant (synchronous IPC, no model). Click a file to open it in the editor.
import { useEffect, useState } from 'react'
import type { CodeMap, CodeDir, CodeFile, CodeSymbol } from '../../../shared/types'

const KIND_COLOR: Record<string, string> = {
  function: 'var(--color-file-node-foreground)', fn: 'var(--color-file-node-foreground)',
  def: 'var(--color-file-node-foreground)', fun: 'var(--color-file-node-foreground)',
  class: 'var(--color-skill-node-foreground)',
  interface: 'var(--color-command-node-foreground)', type: 'var(--color-command-node-foreground)',
  const: 'var(--color-subagent-node-foreground)',
  struct: 'var(--color-session-node-foreground)', enum: 'var(--color-session-node-foreground)',
  trait: 'var(--color-session-node-foreground)', method: 'var(--color-accent-orange)',
}

function Sym({ s }: { s: CodeSymbol }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 py-0.5 pl-1 text-[12px]" style={{ color: KIND_COLOR[s.kind] ?? 'var(--color-foreground-subtle)' }}>
      <span className="font-mono text-[9px] opacity-50 uppercase">{s.kind}</span>
      <span className="font-mono">{s.name}</span>
      <span className="text-[10px] text-foreground-subtlest">:{s.line}</span>
    </div>
  )
}

function FileNode({ file, onOpen }: { file: CodeFile; onOpen?: (path: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div className="flex items-center gap-1 py-0.5 rounded cursor-pointer transition-colors hover:bg-surface-hover"
           onClick={() => setOpen((o) => !o)} onDoubleClick={() => onOpen?.(file.path)}>
        <span className="w-3 text-[10px] text-foreground-subtlest">{open ? '▾' : '▸'}</span>
        <span className="text-[12.5px] text-foreground">{file.name}</span>
        {file.symbols.length > 0 && <span className="ml-auto rounded-full bg-tag px-1.5 text-[10px] text-foreground-subtlest">{file.symbols.length}</span>}
      </div>
      {open && file.symbols.length > 0 && (
        <div className="ml-4 flex flex-col border-l border-border pl-2">
          {file.symbols.map((s, i) => <Sym key={i} s={s} />)}
        </div>
      )}
    </div>
  )
}

function DirNode({ dir, onOpen, depth }: { dir: CodeDir; onOpen?: (path: string) => void; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1) // top-level dirs open by default
  const childCount = dir.files.length + dir.dirs.length
  if (childCount === 0) return <></>
  return (
    <div>
      <div className="flex cursor-pointer items-center gap-1 rounded py-0.5 transition-colors hover:bg-surface-hover" onClick={() => setOpen((o) => !o)}>
        <span className="w-3 text-[10px] text-foreground-subtlest">{open ? '▾' : '▸'}</span>
        <span className="text-[13px] font-medium text-foreground">{dir.name}/</span>
      </div>
      {open && (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
          {dir.dirs.map((d, i) => <DirNode key={i} dir={d} onOpen={onOpen} depth={depth + 1} />)}
          {dir.files.map((f, i) => <FileNode key={i} file={f} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  )
}

export function CodemapPane(props: { workspace: string; active: boolean; onOpenSource?: (path: string) => void }): React.JSX.Element {
  const [map, setMap] = useState<CodeMap | null>(null)
  useEffect(() => { if (props.active && props.workspace) void window.grasp.codemap(props.workspace).then(setMap) }, [props.active, props.workspace])
  if (!map) return <div className="p-4 text-[13px] text-foreground-subtle">Scanning…</div>
  if (!map.ok || !map.tree) return <div className="p-4 text-[13px] text-foreground-subtle">{map.error ?? 'Nothing to map.'}</div>
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-foreground-subtle">Codemap</span>
        <span className="text-[11px] text-foreground-subtlest">{map.fileCount} files · {map.symbolCount} symbols</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {map.tree.dirs.map((d, i) => <DirNode key={i} dir={d} onOpen={props.onOpenSource} depth={0} />)}
        {map.tree.files.map((f, i) => <FileNode key={i} file={f} onOpen={props.onOpenSource} />)}
      </div>
    </div>
  )
}
