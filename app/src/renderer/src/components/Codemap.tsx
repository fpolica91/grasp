// Codemap right pane — the AI-generated structural code map (<ws>/.grasp/codemap.md):
// symbols + roles + dependencies + entry points. Generate/regenerate via one-shot.
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RepoWiki } from '../../../shared/types'

export function CodemapPane(props: { workspace: string; backend: string; model: string; active: boolean }): React.JSX.Element {
  const [map, setMap] = useState<RepoWiki | null>(null)
  const [busy, setBusy] = useState(false)
  const read = async (): Promise<void> => { if (props.workspace) setMap(await window.grasp.codemapRead(props.workspace)) }
  useEffect(() => { if (props.active && props.workspace) void read() }, [props.active, props.workspace])
  const gen = async (): Promise<void> => {
    if (!props.workspace || busy) return
    setBusy(true)
    setMap(await window.grasp.codemapGenerate(props.workspace, props.backend, props.model))
    setBusy(false)
  }
  const has = !!(map?.ok && map.markdown)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-foreground-subtle">Codemap</span>
        {map?.generatedAt ? <span className="text-[11px] text-foreground-subtlest">{new Date(map.generatedAt).toLocaleString()}</span> : null}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={gen}
          disabled={busy || !props.workspace}
          className="rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          title="Generate a structural map of the repo's symbols + dependencies"
        >{busy ? 'Generating…' : has ? 'Regenerate' : 'Generate'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {has ? (
          <div className="prose max-w-none text-[13px] leading-relaxed text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{map!.markdown!}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-[13px] text-foreground-subtle">
            {busy ? 'Mapping the repo structure…' : map?.error ? `${map.error}` : 'No codemap yet — click Generate to map the repo’s symbols, dependencies, and entry points.'}
          </div>
        )}
      </div>
    </div>
  )
}
