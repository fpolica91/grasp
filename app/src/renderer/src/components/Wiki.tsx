// Repo Wiki right pane: renders the AI-generated repo doc (<ws>/.grasp/wiki.md) and
// generates/regenerates it via a one-shot model call. Markdown only — no verdicts.
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RepoWiki } from '../../../shared/types'

export function WikiPane(props: { workspace: string; backend: string; model: string; active: boolean }): React.JSX.Element {
  const [wiki, setWiki] = useState<RepoWiki | null>(null)
  const [busy, setBusy] = useState(false)
  const read = async (): Promise<void> => { if (props.workspace) setWiki(await window.grasp.wikiRead(props.workspace)) }
  useEffect(() => { if (props.active && props.workspace) void read() }, [props.active, props.workspace])
  const gen = async (): Promise<void> => {
    if (!props.workspace || busy) return
    setBusy(true)
    setWiki(await window.grasp.wikiGenerate(props.workspace, props.backend, props.model))
    setBusy(false)
  }
  const has = !!(wiki?.ok && wiki.markdown)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-foreground-subtle">Repo Wiki</span>
        {wiki?.generatedAt ? <span className="text-[11px] text-foreground-subtlest">{new Date(wiki.generatedAt).toLocaleString()}</span> : null}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={gen}
          disabled={busy || !props.workspace}
          className="rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          title="Generate the repo wiki from README + manifests + file tree"
        >{busy ? 'Generating…' : has ? 'Regenerate' : 'Generate'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {has ? (
          <div className="prose max-w-none text-[13px] leading-relaxed text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{wiki!.markdown!}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-[13px] text-foreground-subtle">
            {busy ? 'Generating wiki from the repo…' : wiki?.error ? `${wiki.error}` : 'No wiki yet — click Generate to produce one from the README, manifests, and file tree.'}
          </div>
        )}
      </div>
    </div>
  )
}
