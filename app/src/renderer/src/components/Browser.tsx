// The in-app browser pane — an Electron <webview> with a URL bar and nav, for previewing
// a local dev server or reading docs without leaving grasp. The <webview> is created via
// createElement so we don't fight React's JSX typing for a custom element.
import { createElement, useEffect, useRef, useState } from 'react'

// Minimal shape of the Electron webview DOM element we use.
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
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}` // looks like a domain
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}` // otherwise search
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
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        /* not ready */
      }
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      onNavigate()
    }
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
    <div className="browser">
      <div className="browser-bar">
        <button className="nav" disabled={!nav.back} onClick={() => ref.current?.goBack()} title="Back">
          ‹
        </button>
        <button className="nav" disabled={!nav.forward} onClick={() => ref.current?.goForward()} title="Forward">
          ›
        </button>
        <button className="nav" onClick={() => ref.current?.reload()} title="Reload">
          ↻
        </button>
        <input
          className="url"
          value={bar}
          onChange={(e) => setBar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(bar)
          }}
          placeholder="localhost:3000, a URL, or a search…"
          spellCheck={false}
        />
        <span className={`browser-status${loading ? ' on' : ''}`}>{loading ? 'loading…' : ''}</span>
      </div>
      {createElement('webview', {
        ref,
        className: 'wv',
        src: 'about:blank',
        partition: 'persist:grasp-browser',
        allowpopups: 'true'
      })}
      {current === 'about:blank' && !loading && (
        <div className="browser-empty">Enter a URL to preview your app or read docs — grasp keeps the dataflow on the right.</div>
      )}
    </div>
  )
}
