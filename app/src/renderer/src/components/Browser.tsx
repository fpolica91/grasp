// The in-app browser pane — an Electron <webview> with a URL bar and nav, for previewing
// a local dev server or reading docs without leaving grasp. Migrated to Tailwind v4.
import { createElement, useEffect, useRef, useState } from 'react'

interface Webview extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

function normalize(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^https?:\/\//.test(s) || s.startsWith('about:')) return s
  if (/^localhost(:\d+)?/.test(s) || /^\d+\.\d+\.\d+\.\d+/.test(s)) return `http://${s}`
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

export function BrowserPane({ active }: { active: boolean }): React.JSX.Element {
  const ref = useRef<Webview | null>(null)
  const [bar, setBar] = useState('')
  const [current, setCurrent] = useState('about:blank')
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onNavigate = (): void => {
      const u = wv.getURL()
      setCurrent(u)
      setBar(u === 'about:blank' ? '' : u)
      try { setNav({ back: wv.canGoBack(), forward: wv.canGoForward() }) } catch { /* */ }
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => { setLoading(false); onNavigate() }
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
    }
  }, [])

  const go = (raw: string): void => {
    const url = normalize(raw)
    if (!url) return
    setBar(url)
    ref.current?.loadURL(url)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <button
          className="flex size-6 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-30"
          disabled={!nav.back}
          onClick={() => ref.current?.goBack()}
          title="Back"
        >
          ‹
        </button>
        <button
          className="flex size-6 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-30"
          disabled={!nav.forward}
          onClick={() => ref.current?.goForward()}
          title="Forward"
        >
          ›
        </button>
        <button
          className="flex size-6 items-center justify-center rounded-md text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
          onClick={() => ref.current?.reload()}
          title="Reload"
        >
          ↻
        </button>
        <input
          className="flex-1 rounded-md border border-border bg-input px-2.5 py-1 text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover"
          value={bar}
          onChange={(e) => setBar(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(bar) }}
          placeholder="localhost:3000, a URL, or a search…"
          spellCheck={false}
        />
        {loading && <span className="text-[11px] text-foreground-subtlest">loading…</span>}
      </div>
      {createElement('webview', {
        ref,
        className: 'flex-1 border-0',
        src: 'about:blank',
        partition: 'persist:grasp-browser',
        allowpopups: 'true',
        style: { display: current === 'about:blank' && !loading ? 'none' : 'flex' }
      })}
      {current === 'about:blank' && !loading && (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-foreground-subtlest">
          Enter a URL to preview your app or read docs — grasp keeps the dataflow on the right.
        </div>
      )}
    </div>
  )
}
