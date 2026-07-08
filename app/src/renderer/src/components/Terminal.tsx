// The integrated terminal pane. A real pty in the workspace, drawn with xterm — run
// tests, dev servers, or `claude` here and read errors without leaving grasp. Mounted
// once and kept alive (shown/hidden by the pane switch), so long-running processes
// survive tab changes. Migrated to Tailwind v4.
import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function TerminalDock({
  workspace,
  active,
  onCloseDock
}: {
  workspace: string
  active: boolean
  onCloseDock: () => void
}): React.JSX.Element {
  const nextId = useRef(1)
  const [terms, setTerms] = useState<string[]>(['term-0'])
  const split = (): void => setTerms((t) => [...t, `term-${nextId.current++}`])
  const closeTerm = (id: string): void => setTerms((t) => (t.length > 1 ? t.filter((x) => x !== id) : t))
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-panel px-3 pt-1.5">
        <button className="border-b-2 border-foreground px-3 pb-1.5 text-[13px] font-medium text-foreground">Terminal</button>
        <button
          className="flex size-6 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
          onClick={split}
          title="Split terminal"
        >
          ＋
        </button>
        <button
          className="ml-auto flex size-6 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
          onClick={onCloseDock}
          title="Hide terminal (⌃`)"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="grasp-terms">
          {terms.map((id, i) => (
            <PanelFragment key={id} id={id} first={i === 0} multi={terms.length > 1}>
              <TerminalPane id={id} workspace={workspace} active={active} onClose={() => closeTerm(id)} />
            </PanelFragment>
          ))}
        </PanelGroup>
      </div>
    </div>
  )
}

function PanelFragment({
  id, first, multi, children
}: {
  id: string
  first: boolean
  multi: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {!first && <PanelResizeHandle className="w-px shrink-0 bg-border" />}
      <Panel minSize={15} className="relative h-full" id={id} order={first ? 0 : 1}>
        {children}
      </Panel>
    </>
  )
}

export function TerminalPane({
  id, workspace, active, onClose
}: {
  id: string
  workspace: string
  active: boolean
  onClose?: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !workspace) return
    const term = new XTerm({
      fontFamily: 'ui-monospace, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#161616',
        foreground: '#d4d4d4',
        cursor: '#f8f8f8',
        selectionBackground: '#4099ff47',
        // ZCode's exact ANSI palette (.theme-zai-dark)
        black: '#363636', red: '#ff5c5c', green: '#46bf72', yellow: '#ff8a30',
        blue: '#4099ff', magenta: '#7b5ce5', cyan: '#42c8c8', white: '#adadad',
        brightBlack: '#747474', brightRed: '#f99', brightGreen: '#87d9a4', brightYellow: '#ffb26b',
        brightBlue: '#80beff', brightMagenta: '#a888f2', brightCyan: '#8ee5e5', brightWhite: '#f8f8f8'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    try { fit.fit() } catch { /* */ }
    window.grasp.termCreate(id, workspace || '.', term.cols, term.rows)
    const offData = window.grasp.onTermData((tid, data) => { if (tid === id) term.write(data) })
    const offExit = window.grasp.onTermExit((tid) => { if (tid === id) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n') })
    term.onData((d) => window.grasp.termWrite(id, d))

    const ro = new ResizeObserver(() => {
      try { fit.fit(); window.grasp.termResize(id, term.cols, term.rows) } catch { /* */ }
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      window.grasp.termKill(id)
      term.dispose()
    }
  }, [id, workspace])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        if (termRef.current) window.grasp.termResize(id, termRef.current.cols, termRef.current.rows)
        termRef.current?.focus()
      } catch { /* */ }
    }, 30)
    return () => clearTimeout(t)
  }, [active, id])

  return (
    <div className="relative h-full p-1">
      {onClose && (
        <button
          className="absolute right-1 top-1 z-10 flex size-5 items-center justify-center rounded text-[11px] text-foreground-subtlest opacity-0 transition-opacity hover:text-destructive [.term-wrap:hover_&]:opacity-100"
          onClick={onClose}
          title="Close this terminal"
        >
          ✕
        </button>
      )}
      <div className="h-full w-full" ref={hostRef} />
    </div>
  )
}
