// The integrated terminal pane. A real pty in the workspace, drawn with xterm — run
// tests, dev servers, or `claude` here and read errors without leaving grasp. Mounted
// once and kept alive (shown/hidden by the pane switch), so long-running processes
// survive tab changes.
import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// A dock of one or more terminals, split side-by-side (VSCode: "split terminal" adds one
// to the right). "+" adds a split; each split closes independently; last one stays.
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
    <div className="term-dock">
      <div className="panebar">
        <button className="on">Terminal</button>
        <button className="term-split" onClick={split} title="Split terminal">
          ＋
        </button>
        <button className="dock-toggle" onClick={onCloseDock} title="Hide terminal (⌃`)">
          ✕
        </button>
      </div>
      <div className="term-splits">
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
  id,
  first,
  multi,
  children
}: {
  id: string
  first: boolean
  multi: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {!first && <PanelResizeHandle className="rh rh-v" />}
      <Panel minSize={15} className={`term-split-panel${multi ? ' multi' : ''}`} id={id} order={first ? 0 : 1}>
        {children}
      </Panel>
    </>
  )
}

export function TerminalPane({
  id,
  workspace,
  active,
  onClose
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
    // Wait for the resolved workspace so we don't spawn a throwaway pty in the app dir
    // first (which would leave a stale "[process exited]" prompt).
    if (!host || !workspace) return
    const term = new XTerm({
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#0e1116',
        foreground: '#e9edf4',
        cursor: '#5b93ff',
        selectionBackground: '#2c477a',
        black: '#151922', red: '#e6738a', green: '#7fb98a', yellow: '#e8b160',
        blue: '#5b93ff', magenta: '#b48ce6', cyan: '#5bb4c4', white: '#a2adbf'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      /* container not sized yet */
    }
    window.grasp.termCreate(id, workspace || '.', term.cols, term.rows)
    const offData = window.grasp.onTermData((tid, data) => {
      if (tid === id) term.write(data)
    })
    const offExit = window.grasp.onTermExit((tid) => {
      if (tid === id) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })
    term.onData((d) => window.grasp.termWrite(id, d))

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.grasp.termResize(id, term.cols, term.rows)
      } catch {
        /* ignore transient sizing */
      }
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

  // Re-fit and focus when the pane becomes visible (xterm can't measure while hidden).
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        if (termRef.current) window.grasp.termResize(id, termRef.current.cols, termRef.current.rows)
        termRef.current?.focus()
      } catch {
        /* ignore */
      }
    }, 30)
    return () => clearTimeout(t)
  }, [active, id])

  return (
    <div className="term-wrap">
      {onClose && (
        <button className="term-close" onClick={onClose} title="Close this terminal">
          ✕
        </button>
      )}
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
