// Repo Wiki right pane: renders the AI-generated repo doc (<ws>/.grasp/wiki.md) and
// generates/regenerates it via a one-shot model call. Markdown only — no verdicts.
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RepoWiki } from '../../../shared/types'

// Doc-tuned markdown components — the Tailwind reset strips all default heading/list
// styling, so without these the wiki renders as an unreadable wall of same-size text.
const wikiComponents = {
  h1: (p: React.ComponentProps<'h1'>) => <h1 className="mb-3 mt-1 border-b border-border pb-2 text-[1.25rem] font-semibold tracking-tight text-foreground" {...p} />,
  h2: (p: React.ComponentProps<'h2'>) => <h2 className="mb-2 mt-6 text-[1rem] font-semibold text-foreground" {...p} />,
  h3: (p: React.ComponentProps<'h3'>) => <h3 className="mb-1.5 mt-4 text-[0.875rem] font-semibold text-foreground" {...p} />,
  p: (p: React.ComponentProps<'p'>) => <p className="mb-3 leading-relaxed text-foreground-subtle" {...p} />,
  ul: (p: React.ComponentProps<'ul'>) => <ul className="mb-3 flex list-disc flex-col gap-1 pl-5 marker:text-foreground-subtlest" {...p} />,
  ol: (p: React.ComponentProps<'ol'>) => <ol className="mb-3 flex list-decimal flex-col gap-1 pl-5 marker:text-foreground-subtlest" {...p} />,
  li: (p: React.ComponentProps<'li'>) => <li className="leading-relaxed text-foreground-subtle" {...p} />,
  strong: (p: React.ComponentProps<'strong'>) => <strong className="font-semibold text-foreground" {...p} />,
  a: (p: React.ComponentProps<'a'>) => <a className="text-accent-blue underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  hr: () => <hr className="my-4 border-border" />,
  code: ({ className, children, ...rest }: React.ComponentProps<'code'>) =>
    className?.includes('language-') ? (
      <code className={`${className} block overflow-x-auto`} {...rest}>{children}</code>
    ) : (
      <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[0.75rem] text-foreground" {...rest}>{children}</code>
    ),
  pre: (p: React.ComponentProps<'pre'>) => <pre className="mb-3 overflow-x-auto rounded-lg border border-border bg-surface px-3.5 py-2.5 font-mono text-[0.75rem] leading-relaxed text-foreground" {...p} />,
  table: (p: React.ComponentProps<'table'>) => <table className="mb-3 w-full border-collapse text-[0.8125rem]" {...p} />,
  th: (p: React.ComponentProps<'th'>) => <th className="border-b border-border px-2 py-1.5 text-left font-semibold text-foreground" {...p} />,
  td: (p: React.ComponentProps<'td'>) => <td className="border-b border-border/50 px-2 py-1.5 text-foreground-subtle" {...p} />
}

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
        <span className="text-[0.75rem] font-medium text-foreground-subtle">Repo Wiki</span>
        {wiki?.generatedAt ? <span className="text-[0.6875rem] text-foreground-subtlest">{new Date(wiki.generatedAt).toLocaleString()}</span> : null}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={gen}
          disabled={busy || !props.workspace}
          className="rounded-md border border-border bg-card px-2 py-1 text-[0.75rem] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          title="Generate the repo wiki from README + manifests + file tree"
        >{busy ? 'Generating…' : has ? 'Regenerate' : 'Generate'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {has ? (
          <div className="mx-auto max-w-[760px] text-[0.8125rem]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={wikiComponents}>{wiki!.markdown!}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-[0.8125rem] text-foreground-subtle">
            {busy ? 'Generating wiki from the repo…' : wiki?.error ? `${wiki.error}` : 'No wiki yet — click Generate to produce one from the README, manifests, and file tree.'}
          </div>
        )}
      </div>
    </div>
  )
}
