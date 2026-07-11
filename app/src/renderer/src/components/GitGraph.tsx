// The Git Graph right pane: commit history with branch refs + safe git actions.
// grasp already shells git for checkpoints; this is the human-facing read/edit surface.
import { useEffect, useState } from 'react'
import type { GitGraph as Graph } from '../../../shared/types'

function parseRefs(refs: string): { name: string; head?: boolean; remote?: boolean; tag?: boolean }[] {
  // refs looks like ' (HEAD -> main, origin/main, tag: v1)' (may be empty)
  const inner = refs.replace(/[()]/g, '').trim()
  if (!inner) return []
  return inner.split(',').map((p) => {
    const t = p.trim()
    const head = t.startsWith('HEAD ->')
    const tag = t.startsWith('tag:')
    const name = t.replace(/^HEAD ->\s*/, '').replace(/^tag:\s*/, '').trim()
    return { name, head, tag, remote: name.includes('/') }
  })
}

const LANE_W = 14 // px between lanes
const ROW_H = 44 // px per commit row — matches the list row height
const LANE_COLORS = ['#378ADD', '#1D9E75', '#D85A30', '#D4537E', '#7F77DD', '#BA7517', '#639922', '#0F6E56']
const laneColor = (i: number): string => LANE_COLORS[i % LANE_COLORS.length]

interface Placed {
  hash: string
  lane: number
  parentLanes: number[] // lane each parent will occupy (for connector curves)
  merge: boolean
  color: string
}

// Assign a lane to every commit and figure out where its parents land, so the SVG can
// draw continuous colored tracks with branch/merge curves — the GitKraken feel, computed
// purely from the parent DAG grasp already has.
function computeLanes(commits: { hash: string; parents: string[] }[]): { placed: Placed[]; laneCount: number } {
  let lanes: (string | null)[] = [] // lanes[i] = hash the i-th lane is currently waiting to draw
  const placed: Placed[] = []
  let maxLane = 0
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash)
    if (lane === -1) {
      lane = lanes.indexOf(null)
      if (lane === -1) { lane = lanes.length; lanes.push(null) }
      lanes[lane] = c.hash
    }
    // free every other lane that was also waiting for this same commit (branch tips merging in)
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null
    const parentLanes: number[] = []
    c.parents.forEach((p, pi) => {
      if (pi === 0) {
        lanes[lane] = p // first parent continues this lane
        parentLanes.push(lane)
      } else {
        let pl = lanes.indexOf(p)
        if (pl === -1) {
          pl = lanes.indexOf(null)
          if (pl === -1) { pl = lanes.length; lanes.push(null) }
          lanes[pl] = p
        }
        parentLanes.push(pl)
      }
    })
    if (c.parents.length === 0) lanes[lane] = null
    maxLane = Math.max(maxLane, lanes.length)
    placed.push({ hash: c.hash, lane, parentLanes, merge: c.parents.length > 1, color: laneColor(lane) })
  }
  // trim trailing empties
  while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
  return { placed, laneCount: Math.max(maxLane, 1) }
}

// The lane graph itself: continuous vertical tracks + a dot per commit + curved
// connectors from each commit down to where its parents sit.
function LaneGraph({ commits, placedById, laneCount }: {
  commits: { hash: string }[]
  placedById: Map<string, Placed>
  laneCount: number
}): React.JSX.Element {
  const width = laneCount * LANE_W + LANE_W
  const height = commits.length * ROW_H
  const cx = (lane: number): number => LANE_W / 2 + lane * LANE_W
  const cy = (row: number): number => ROW_H / 2 + row * ROW_H
  const rowOf = new Map(commits.map((c, i) => [c.hash, i]))
  const paths: React.JSX.Element[] = []
  commits.forEach((c, row) => {
    const p = placedById.get(c.hash)
    if (!p) return
    p.parentLanes.forEach((pl, pi) => {
      const parentHash = (c as { parents?: string[] }).parents?.[pi]
      const prow = parentHash != null ? rowOf.get(parentHash) : undefined
      const x1 = cx(p.lane), y1 = cy(row)
      const x2 = cx(pl)
      const y2 = prow != null ? cy(prow) : height // parent off-screen -> run to bottom
      const color = pl === p.lane ? p.color : laneColor(pl)
      const d = x1 === x2
        ? `M${x1} ${y1} L${x2} ${y2}`
        : `M${x1} ${y1} C${x1} ${y1 + ROW_H * 0.5}, ${x2} ${y2 - ROW_H * 0.5}, ${x2} ${y2}`
      paths.push(<path key={`${c.hash}-${pi}`} d={d} stroke={color} strokeWidth={1.6} fill="none" />)
    })
  })
  return (
    <svg width={width} height={height} className="shrink-0" style={{ minWidth: width }}>
      {paths}
      {commits.map((c, row) => {
        const p = placedById.get(c.hash)
        if (!p) return null
        return <circle key={c.hash} cx={cx(p.lane)} cy={cy(row)} r={p.merge ? 3.4 : 4.2}
          fill={p.merge ? 'var(--color-background)' : p.color} stroke={p.color} strokeWidth={p.merge ? 2 : 1.5} />
      })}
    </svg>
  )
}

function ActButton({ label, title, onClick, disabled }: { label: string; title: string; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="rounded-md border border-border bg-card px-2 py-1 text-[0.71875rem] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
    >{label}</button>
  )
}

export function GitGraphPane({ workspace, active }: { workspace: string; active: boolean }): React.JSX.Element {
  const [graph, setGraph] = useState<Graph | null>(null)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    const g = await window.grasp.gitGraph(workspace)
    setGraph(g)
    setLoading(false)
  }
  useEffect(() => { if (active && workspace) void refresh() }, [active, workspace])

  const act = async (op: 'fetch' | 'pull' | 'push' | 'stageAll' | 'commit' | 'checkout' | 'newBranch' | 'merge' | 'rebase', arg?: string): Promise<void> => {
    const r = await window.grasp.gitAction(workspace, op, arg)
    setNote(r.ok ? `${op} ok` : `${op} failed: ${r.out.slice(0, 160)}`)
    void refresh()
  }
  const promptAct = (op: 'commit' | 'newBranch' | 'merge' | 'rebase', msg: string): void => {
    const v = window.prompt(msg, op === 'commit' ? 'update' : '')
    if (v) void act(op, v)
  }

  if (!graph) {
    return <div className="p-4 text-[0.8125rem] text-foreground-subtle">{loading ? 'Loading…' : 'No repo.'}</div>
  }
  if (!graph.ok) {
    return <div className="p-4 text-[0.8125rem] text-foreground-subtle">{graph.error ?? 'No git repo at this workspace.'}</div>
  }
  const { placed, laneCount } = computeLanes(graph.commits)
  const placedById = new Map(placed.map((p) => [p.hash, p]))

  return (
    <div className="flex h-full flex-col">
      {/* header: branch + actions */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-tag px-2 py-0.5 text-[0.71875rem] font-medium text-foreground">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" /><circle cx="18" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.7" /><path d="M6 8.4v7.2M6 12c0-3 3-3 6-3h3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          {graph.branch}
        </span>
        {graph.dirty && <span className="size-2 rounded-full bg-warning" title="working tree has changes" />}
        {graph.ahead ? <span className="text-[0.6875rem] text-foreground-subtlest" title="commits not pushed">↑{graph.ahead}</span> : null}
        {graph.behind ? <span className="text-[0.6875rem] text-foreground-subtlest" title="commits on remote">↓{graph.behind}</span> : null}
        <span className="ml-auto" />
        <ActButton label="Fetch" title="git fetch --all --prune" onClick={() => act('fetch')} />
        <ActButton label="Pull" title="git pull --ff-only" onClick={() => act('pull')} disabled={graph.dirty} />
        <ActButton label="Push" title="git push" onClick={() => act('push')} disabled={!graph.ahead} />
        <ActButton label="Stage" title="git add -A" onClick={() => act('stageAll')} disabled={!graph.dirty} />
        <ActButton label="Commit" title="commit all staged changes" onClick={() => promptAct('commit', 'Commit message:')} disabled={!graph.dirty} />
        <ActButton label="New" title="create + switch to a new branch" onClick={() => promptAct('newBranch', 'New branch name:')} />
      </div>
      {note && <div className="border-b border-border bg-surface px-3 py-1 text-[0.6875rem] text-foreground-subtle">{note}</div>}

      {/* commit graph: SVG lanes on the left, one fixed-height row per commit on the right */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex px-3 py-2">
          <LaneGraph commits={graph.commits} placedById={placedById} laneCount={laneCount} />
          <div className="min-w-0 flex-1">
            {graph.commits.map((c) => {
              const refs = parseRefs(c.refs)
              const isMerge = c.parents.length > 1
              const head = refs.some((r) => r.head)
              return (
                <div key={c.hash} className="group flex flex-col justify-center border-l border-transparent pl-2 hover:border-border" style={{ height: ROW_H }}>
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate text-[0.8125rem] ${head ? 'font-medium text-foreground' : 'text-foreground'}`}>{c.subject}</span>
                    {isMerge && <span className="shrink-0 rounded bg-tag px-1 text-[0.625rem] text-foreground-subtlest">merge</span>}
                    {refs.map((r, i) => (
                      <span key={i} className={`shrink-0 rounded-full px-1.5 text-[0.625rem] ${r.head ? 'bg-accent-blue/20 text-foreground' : r.remote ? 'bg-tag text-foreground-subtle' : r.tag ? 'bg-warning/15 text-warning' : 'border border-border text-foreground-subtle'}`}>{r.name}</span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 text-[0.6875rem] text-foreground-subtlest">
                    <span className="font-mono text-foreground-subtle">{c.short}</span>
                    <span className="truncate">{c.author}</span>
                    <span>· {c.date}</span>
                  </div>
                </div>
              )
            })}
            {graph.commits.length === 0 && <div className="py-4 text-center text-[0.75rem] text-foreground-subtlest">no commits</div>}
          </div>
        </div>
      </div>

      {/* footer: branch switcher + merge/rebase */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <select
          className="min-w-0 flex-1 rounded-md border border-border bg-input px-2 py-1 text-[0.71875rem] text-foreground outline-none"
          value=""
          onChange={(e) => { if (e.target.value) void act('checkout', e.target.value); e.target.value = '' }}
          title="Switch branch"
        >
          <option value="">Switch branch…</option>
          {graph.branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <ActButton label="Merge" title="merge another branch into HEAD" onClick={() => promptAct('merge', 'Branch to merge:')} />
        <ActButton label="Rebase" title="rebase HEAD onto a branch" onClick={() => promptAct('rebase', 'Branch to rebase onto:')} />
      </div>
    </div>
  )
}
