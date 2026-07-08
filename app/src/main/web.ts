// No-key web access for the agent: WebFetch (URL → cleaned text) and WebSearch
// (DuckDuckGo Lite scrape). Both are best-effort and network-dependent; the agent
// should treat results as unverified external content. No API keys, no deps.
const MAX_FETCH = 8000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decode(s: string): string {
  return s.replace(/&(#?\w+);/g, (_m, e: string) => ENTITIES[e] ?? ' ')
}
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/<[^>]*$/g, ' ')
}

export interface FetchResult {
  ok: boolean
  text?: string
  status?: number
  contentType?: string
  error?: string
}

/** Fetch a URL and return its text content with HTML stripped, truncated. */
export async function fetchText(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'grasp/0.1 (web_fetch)', accept: 'text/html,application/json,text/plain,*/*' }
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    const ctype = res.headers.get('content-type') ?? ''
    const raw = await res.text()
    let text: string
    if (/\bjson\b/i.test(ctype)) {
      text = raw // leave JSON verbatim — the agent can read structured data
    } else if (/\bhtml\b/i.test(ctype) || /<html|<!doctype/i.test(raw.slice(0, 200))) {
      text = decode(stripTags(raw))
    } else {
      text = raw
    }
    text = text.replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length > MAX_FETCH) text = text.slice(0, MAX_FETCH) + `\n…(truncated, ${raw.length} chars total)`
    return { ok: true, text, status: res.status, contentType: ctype }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}
export interface SearchResult {
  ok: boolean
  results?: SearchHit[]
  error?: string
}

/** Search the web via DuckDuckGo Lite (no key). Best-effort; markup may change. */
export async function searchWeb(query: string): Promise<SearchResult> {
  try {
    const body = new URLSearchParams({ q: query, kl: 'us-en' }).toString()
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      body
    })
    if (!res.ok) return { ok: false, error: `search HTTP ${res.status}` }
    const html = await res.text()
    const hits: SearchHit[] = []
    // DDG Lite markup: <a rel="nofollow" href="URL" class='result-link'>title</a> + <td class='result-snippet'>…</td>
    // (single-quoted attrs; href precedes class). Tolerant to single/double quotes.
    const linkRe = /href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g
    const snipRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g
    const links: { url: string; title: string }[] = []
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html))) {
      let url = m[1]
      const uddg = /uddg=([^&]+)/.exec(url)
      if (uddg) {
        try { url = decodeURIComponent(uddg[1]) } catch { /* keep raw */ }
      }
      if (url.startsWith('//')) url = 'https:' + url
      links.push({ url, title: decode(stripTags(m[2])).trim() })
    }
    const snippets: string[] = []
    while ((m = snipRe.exec(html))) snippets.push(decode(stripTags(m[1])).trim())
    for (let i = 0; i < links.length && hits.length < 8; i++) {
      if (/duckduckgo\.com/i.test(links[i].url)) continue // skip DDG nav/sponsored
      hits.push({ title: links[i].title || links[i].url, url: links[i].url, snippet: snippets[i] ?? '' })
    }
    if (!hits.length) return { ok: true, results: [], error: 'no results (DDG may have changed its markup or rate-limited)' }
    return { ok: true, results: hits }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
