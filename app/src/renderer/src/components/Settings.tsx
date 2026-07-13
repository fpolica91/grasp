// Settings — a sectioned modal (left-rail nav + content). Fully migrated to Tailwind v4.
import { useEffect, useState } from 'react'
import type { Theme } from './Sidebar'

const PROVIDERS: { id: string; label: string; hint: string }[] = [
  { id: 'glm', label: 'GLM (Z.ai)', hint: 'z.ai API key — powers glm-4.6 / glm-5.2' },
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'sk-ant-… — powers Claude Sonnet 5 / Opus 4.8 / Haiku 4.5' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-… (or any OpenAI-compatible key)' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', hint: 'api.moonshot.cn key — powers kimi-k2.6' },
  { id: 'deepseek', label: 'DeepSeek', hint: 'api.deepseek.com key — powers deepseek-v4' },
  { id: 'qwen', label: 'Qwen (DashScope)', hint: 'DashScope key — powers qwen3.5-plus' },
  { id: 'xiaomi', label: 'Xiaomi MiMo', hint: 'api.xiaomimimo.com key — powers mimo-v2.5' },
  { id: 'minimax', label: 'MiniMax', hint: 'api.minimaxi.com key — powers MiniMax-M3' },
  { id: 'bigmodel', label: 'BigModel (智谱)', hint: 'open.bigmodel.cn key — China mirror for GLM' }
]

const THEME_DOTS: Record<Theme, string> = {
  graphite: 'linear-gradient(135deg,#161616 50%,#fff 50%)',
  carbon: 'linear-gradient(135deg,#121212 50%,#e8e8e8 50%)',
  daylight: 'linear-gradient(135deg,#fff 50%,#000 50%)'
}
const THEME_LABELS: { id: Theme; label: string }[] = [
  { id: 'graphite', label: 'ZCode Dark' }, { id: 'carbon', label: 'Carbon' }, { id: 'daylight', label: 'ZCode Light' }
]

const SECTIONS = [
  { id: 'marketplace', label: 'Marketplace' }, { id: 'keys', label: 'API keys' },
  { id: 'appearance', label: 'Appearance' }, { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' }, { id: 'plugins', label: 'Plugins' },
  { id: 'commands', label: 'Commands' }, { id: 'keybindings', label: 'Keybindings' },
  { id: 'hooks', label: 'Hooks' }
] as const
type Section = (typeof SECTIONS)[number]['id']

const MCP_CATALOG = [
  { name: 'filesystem', pkg: '@modelcontextprotocol/server-filesystem', desc: 'Read & write files on disk', args: '.' },
  { name: 'github', pkg: '@modelcontextprotocol/server-github', desc: 'Repos, issues, PRs, search', envHint: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
  { name: 'sqlite', pkg: '@modelcontextprotocol/server-sqlite', desc: 'Query SQLite databases' },
  { name: 'postgres', pkg: '@modelcontextprotocol/server-postgres', desc: 'Query PostgreSQL', args: 'postgresql://host/db' },
  { name: 'brave-search', pkg: '@modelcontextprotocol/server-brave-search', desc: 'Web search via Brave', envHint: 'BRAVE_API_KEY' },
  { name: 'puppeteer', pkg: '@modelcontextprotocol/server-puppeteer', desc: 'Browser automation & scraping' },
  { name: 'memory', pkg: '@modelcontextprotocol/server-memory', desc: 'Persistent knowledge graph' },
  { name: 'fetch', pkg: '@modelcontextprotocol/server-fetch', desc: 'Fetch & process web content' },
  { name: 'git', pkg: '@modelcontextprotocol/server-git', desc: 'Git repository operations', args: '--repository .' },
  { name: 'time', pkg: '@modelcontextprotocol/server-time', desc: 'Time & timezone conversion' }
]

const inputCls = 'rounded-lg border border-border bg-input px-3 py-2 text-[0.8125rem] text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-border-hover'
const btnPrimary = 'rounded-lg bg-primary px-3 py-1.5 text-[0.75rem] font-semibold text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-50'
const btnSm = 'rounded-lg border border-border bg-secondary px-2.5 py-1 text-[0.75rem] font-medium text-foreground transition-[filter] hover:brightness-110'

function KeyRow({ provider, label, hint, onSaved }: { provider: string; label: string; hint: string; onSaved: () => void }): React.JSX.Element {
  const [has, setHas] = useState(false)
  const [val, setVal] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => { void window.grasp.keyStatus(provider).then(setHas) }, [provider])
  const save = async (): Promise<void> => {
    const r = await window.grasp.setKey(val.trim(), provider)
    if (r.ok) { setHas(true); setVal(''); setMsg(r.warning ?? 'saved'); onSaved() }
    else setMsg(r.error ?? 'failed')
    setTimeout(() => setMsg(''), 2500)
  }
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[0.8125rem] font-medium text-foreground">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-[0.625rem] ${has ? 'bg-tag text-foreground' : 'border border-border text-foreground-subtlest'}`}>{has ? 'key set' : 'no key'}</span>
      </div>
      <div className="flex gap-2">
        <input type="password" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) void save() }} placeholder={has ? 'replace key…' : 'paste key…'} spellCheck={false} className={`${inputCls} flex-1`} />
        <button className={btnPrimary} disabled={!val.trim()} onClick={() => void save()}>Save</button>
      </div>
      <div className="text-[0.75rem] text-foreground-subtlest">{hint}{msg && <span> · {msg}</span>}</div>
    </div>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={`flex flex-col gap-1 rounded-lg border border-border bg-surface p-3 ${className}`}>{children}</div>
}

function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export function Settings(props: { theme: Theme; onTheme: (t: Theme) => void; onKeysChanged: () => void; skills: { name: string; description: string; source: string; enabled: boolean }[]; onSkillsChanged: () => void; mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; transport?: string; disabled?: boolean; disabledTools?: string[] }>; onMcpChanged: () => void; plugins: { name: string; description: string; source: 'user' | 'project'; hasSkills: boolean; mcpCount: number }[]; onPluginsChanged: () => void; commands: { name: string; description: string; skills?: string }[]; keybinds: Record<string, string>; workspace: string; onClose: () => void }): React.JSX.Element {
  useEscapeToClose(props.onClose)
  const [section, setSection] = useState<Section>('marketplace')
  const [mcpName, setMcpName] = useState(''); const [mcpCmd, setMcpCmd] = useState(''); const [mcpArgs, setMcpArgs] = useState(''); const [mcpEnv, setMcpEnv] = useState('')
  const [mcpKind, setMcpKind] = useState<'stdio' | 'http'>('stdio'); const [mcpUrl, setMcpUrl] = useState(''); const [mcpHeaders, setMcpHeaders] = useState('')
  const [mcpExpanded, setMcpExpanded] = useState<string | null>(null)
  const parseKV = (text: string): Record<string, string> => {
    const o: Record<string, string> = {}
    for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1) }
    return o
  }
  const addMcp = (): void => {
    const name = mcpName.trim(); if (!name) return
    const cfg = mcpKind === 'http'
      ? { url: mcpUrl.trim(), transport: 'http', ...(mcpHeaders.trim() ? { headers: parseKV(mcpHeaders) } : {}) }
      : { command: mcpCmd.trim(), ...(mcpArgs.trim() ? { args: mcpArgs.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? [] } : {}), ...(mcpEnv.trim() ? { env: parseKV(mcpEnv) } : {}) }
    void window.grasp.saveMcpConfig(name, cfg).then(props.onMcpChanged)
    setMcpName(''); setMcpCmd(''); setMcpArgs(''); setMcpEnv(''); setMcpUrl(''); setMcpHeaders('')
  }
  const toggleMcpDisabled = (name: string, cfg: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; transport?: string; disabled?: boolean; disabledTools?: string[] }): void => {
    void window.grasp.saveMcpConfig(name, { ...cfg, disabled: !cfg.disabled }).then(props.onMcpChanged)
  }
  const [mcpStatusList, setMcpStatusList] = useState<{ name: string; ok: boolean; error?: string; toolCount: number; disabled?: boolean; transport?: string; tools?: string[] }[]>([])
  const [pluginUrl, setPluginUrl] = useState(''); const [pluginMsg, setPluginMsg] = useState('')
  useEffect(() => { if (section === 'mcp' && props.workspace) void window.grasp.mcpStatus(props.workspace).then(setMcpStatusList) }, [section, props.workspace, props.mcpServers])
  const [hooksList, setHooksList] = useState<{ event: string; match?: string; command: string; timeout?: number }[]>([])
  useEffect(() => { if (section === 'hooks' && props.workspace) void window.grasp.hooks(props.workspace).then(setHooksList) }, [section, props.workspace])

  const revealBtn = (key: string): React.JSX.Element => (
    <button className="ml-2 border-0 bg-transparent text-[0.6875rem] text-foreground-subtlest underline underline-offset-2 transition-colors hover:text-foreground" onClick={() => void window.grasp.revealInFiles(key)}>reveal in files</button>
  )
  const note = (children: React.ReactNode): React.JSX.Element => (
    <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-foreground-subtle">{children}</p>
  )
  const codeCls = 'rounded bg-tag px-1 py-0.5 font-mono text-[0.6875rem] text-foreground-subtle'

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-[3px]" onClick={props.onClose}>
      <div className="flex h-[90vh] w-[960px] max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex shrink-0 items-center px-6 py-4">
          <h2 className="text-[1.125rem] font-semibold tracking-tight text-foreground">Settings</h2>
          <button className="ml-auto border-0 bg-transparent text-[1rem] text-foreground-subtlest transition-colors hover:text-foreground" onClick={props.onClose} title="Close">✕</button>
        </div>
        {/* Body */}
        <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
          {/* Nav */}
          <nav className="flex w-[130px] shrink-0 flex-col gap-0.5 border-r border-border pr-3.5">
            {SECTIONS.map((s) => (
              <button key={s.id} className={`rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors ${section === s.id ? 'bg-surface font-semibold text-foreground' : 'text-foreground-subtle hover:bg-surface-hover'}`} onClick={() => setSection(s.id)}>{s.label}</button>
            ))}
          </nav>
          {/* Content */}
          <div className="min-w-0 flex-1 overflow-y-auto pr-1">
            {/* Marketplace */}
            {section === 'marketplace' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">MCP Marketplace</div>
                {note(<>One-click install popular MCP tool servers. They run via <code className={codeCls}>npx</code> and appear as agent tools on the next turn.</>)}
                <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
                  {MCP_CATALOG.map((item) => {
                    const installed = item.name in props.mcpServers
                    return (
                      <Card key={item.name} className={installed ? 'border-foreground/20' : ''}>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[0.875rem] font-semibold text-foreground">{item.name}</span>
                          {item.envHint && <span className="rounded-full border border-border px-1.5 py-0 text-[0.625rem] text-foreground-subtlest">needs key</span>}
                        </div>
                        <div className="text-[0.8125rem] text-foreground-subtle">{item.desc}</div>
                        <code className="break-all font-mono text-[0.6875rem] text-foreground-subtlest">{item.pkg}</code>
                        <button className={`${installed ? btnSm : btnPrimary} mt-1.5 self-start`} disabled={installed} onClick={() => void window.grasp.saveMcpServer(item.name, 'npx', `-y ${item.pkg}${item.args ? ' ' + item.args : ''}`, item.envHint ? `${item.envHint}=` : '').then(props.onMcpChanged)}>
                          {installed ? '✓ Installed' : 'Install'}
                        </button>
                      </Card>
                    )
                  })}
                </div>
              </div>
            )}
            {/* Keys */}
            {section === 'keys' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">API keys</div>
                {note(<>Stored encrypted in your OS keychain (safeStorage) — never written in plaintext.</>)}
                {PROVIDERS.map((p) => (<KeyRow key={p.id} provider={p.id} label={p.label} hint={p.hint} onSaved={props.onKeysChanged} />))}
              </div>
            )}
            {/* Appearance */}
            {section === 'appearance' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">Appearance</div>
                <div className="mt-3 flex gap-2">
                  {THEME_LABELS.map((t) => (
                    <button key={t.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[0.8125rem] transition-colors ${props.theme === t.id ? 'border-foreground text-foreground' : 'border-border text-foreground-subtle hover:bg-surface-hover'}`} onClick={() => props.onTheme(t.id)}>
                      <span className="size-4 rounded-full" style={{ background: THEME_DOTS[t.id] }} />
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Skills */}
            {section === 'skills' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">Skills {revealBtn('skills')}</div>
                {note(<>Reusable instructions the agent loads via <code className={codeCls}>use_skill</code>. Install in <code className={codeCls}>~/.grasp/skills</code>.</>)}
                {props.skills.length === 0 ? <div className="py-4 text-[0.8125rem] text-foreground-subtlest">No skills yet.</div> : (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {props.skills.map((s) => (
                      <Card key={s.name + '|' + s.source} className={s.enabled ? '' : 'opacity-50'}>
                        <div className="flex items-center gap-2">
                          <span className="text-[0.8125rem] font-semibold text-foreground">{s.name}</span>
                          <span className="rounded-full border border-border px-1.5 text-[0.625rem] uppercase text-foreground-subtlest">{s.source}</span>
                          <button className={`ml-auto rounded-full border px-2 py-0.5 text-[0.625rem] transition-colors ${s.enabled ? 'border-foreground text-foreground' : 'border-border text-foreground-subtlest'}`} title={s.enabled ? 'Disable' : 'Enable'} onClick={() => void window.grasp.setSkillEnabled(s.name, !s.enabled).then(props.onSkillsChanged)}>{s.enabled ? 'on' : 'off'}</button>
                        </div>
                        <div className="text-[0.8125rem] text-foreground-subtle">{(s.description || '(no description)').slice(0, 180)}</div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* MCP */}
            {section === 'mcp' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">MCP servers {revealBtn('mcp')}</div>
                {note(<>External tool servers — stdio or HTTP. Saved to <code className={codeCls}>~/.grasp/mcp.json</code>. Secrets: <code className={codeCls}>{'${env:VAR}'}</code> / <code className={codeCls}>{'${file:/path}'}</code>.</>)}
                {Object.keys(props.mcpServers).length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {Object.entries(props.mcpServers).map(([name, s]) => {
                      const st = mcpStatusList.find((x) => x.name === name)
                      const kind = s.transport ?? (s.url ? 'http' : 'stdio')
                      const dot = s.disabled ? 'bg-foreground-subtlest' : st?.ok ? 'bg-git-added' : st?.ok === false ? 'bg-destructive' : 'bg-foreground-subtlest'
                      const open = mcpExpanded === name
                      return (
                        <Card key={name}>
                          <div className="flex items-center gap-2">
                            <span className={`size-2 shrink-0 rounded-full ${dot}`} title={s.disabled ? 'disabled' : st?.ok ? 'connected' : st?.ok === false ? 'failed' : 'unknown'} />
                            <span className={`text-[0.8125rem] font-semibold ${s.disabled ? 'text-foreground-subtle' : 'text-foreground'}`}>{name}</span>
                            <span className="rounded border border-border px-1.5 text-[0.625rem] uppercase text-foreground-subtlest">{kind}</span>
                            {st && !s.disabled && <span className={`rounded-full border px-1.5 text-[0.625rem] ${st.ok === false ? 'border-destructive text-destructive' : 'border-border text-foreground-subtlest'}`}>{st.ok ? `${st.toolCount} tool${st.toolCount === 1 ? '' : 's'}` : 'failed'}</span>}
                            {st?.ok && (st.tools?.length ?? 0) > 0 && <button className="text-[0.625rem] text-foreground-subtlest transition-colors hover:text-foreground" onClick={() => setMcpExpanded(open ? null : name)}>{open ? 'hide' : 'tools'}</button>}
                            <label className="ml-auto flex cursor-pointer items-center gap-1 text-[0.625rem] text-foreground-subtlest" title={s.disabled ? 'Enable this server' : 'Disable without removing'}>
                              <input type="checkbox" checked={!s.disabled} onChange={() => toggleMcpDisabled(name, s)} />
                              {s.disabled ? 'off' : 'on'}
                            </label>
                            <button className="border-0 bg-transparent text-[0.75rem] text-foreground-subtlest transition-colors hover:text-destructive" title="Remove" onClick={() => void window.grasp.deleteMcpServer(name).then(props.onMcpChanged)}>✕</button>
                          </div>
                          <div className="text-[0.8125rem] text-foreground-subtle">
                            <code className={codeCls}>{s.url ? s.url : `${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`}</code>
                            {s.env && <span className="ml-1.5 rounded-full border border-border px-1.5 text-[0.625rem] text-foreground-subtlest">{Object.keys(s.env).length} env</span>}
                            {s.headers && <span className="ml-1.5 rounded-full border border-border px-1.5 text-[0.625rem] text-foreground-subtlest">{Object.keys(s.headers).length} header{Object.keys(s.headers).length === 1 ? '' : 's'}</span>}
                            {st?.error && <div className="mt-1 font-mono text-[0.75rem] text-destructive">{st.error}</div>}
                            {open && st?.tools && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {st.tools.map((t) => <span key={t} className="rounded border border-border px-1.5 py-0.5 font-mono text-[0.625rem] text-foreground-subtle">{t}</span>)}
                              </div>
                            )}
                          </div>
                        </Card>
                      )
                    })}
                  </div>
                )}
                <div className="mt-3 flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
                  <div className="flex items-center gap-1.5">
                    <input className={`${inputCls} w-[130px]`} placeholder="name" value={mcpName} onChange={(e) => setMcpName(e.target.value)} spellCheck={false} />
                    <span className="ml-auto flex items-center rounded-lg bg-tag p-0.5 text-[0.6875rem]">
                      <button className={`rounded px-2 py-0.5 transition-colors ${mcpKind === 'stdio' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => setMcpKind('stdio')}>stdio</button>
                      <button className={`rounded px-2 py-0.5 transition-colors ${mcpKind === 'http' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-foreground-subtle hover:text-foreground'}`} onClick={() => setMcpKind('http')}>HTTP</button>
                    </span>
                  </div>
                  {mcpKind === 'stdio' ? (
                    <>
                      <div className="flex gap-1.5">
                        <input className={`${inputCls} flex-1`} placeholder="command (e.g. npx)" value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} spellCheck={false} />
                        <input className={`${inputCls} flex-1`} placeholder={'args (quote spaces: "foo bar")'} value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} spellCheck={false} />
                      </div>
                      <textarea className={`${inputCls} w-full font-mono`} placeholder="env: KEY=VALUE per line — use ${env:VAR} to reference a secret" value={mcpEnv} onChange={(e) => setMcpEnv(e.target.value)} rows={1} spellCheck={false} />
                    </>
                  ) : (
                    <>
                      <input className={`${inputCls} w-full`} placeholder="url (https://…/mcp)" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} spellCheck={false} />
                      <textarea className={`${inputCls} w-full font-mono`} placeholder="headers: Name=Value per line — e.g. Authorization=Bearer ${env:TOKEN}" value={mcpHeaders} onChange={(e) => setMcpHeaders(e.target.value)} rows={1} spellCheck={false} />
                    </>
                  )}
                  <button className={`${btnPrimary} self-start`} disabled={!mcpName.trim() || (mcpKind === 'stdio' ? !mcpCmd.trim() : !mcpUrl.trim())} onClick={addMcp}>Add server</button>
                </div>
              </div>
            )}
            {/* Plugins */}
            {section === 'plugins' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">Plugins {revealBtn('plugins')}</div>
                {note(<>Distribution units that bundle skills + optionally MCP. Install from a git URL.</>)}
                {props.plugins.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {props.plugins.map((p) => (
                      <Card key={p.name + '|' + p.source}>
                        <div className="flex items-center gap-2">
                          <span className="text-[0.8125rem] font-semibold text-foreground">{p.name}</span>
                          <span className="rounded-full border border-border px-1.5 text-[0.625rem] uppercase text-foreground-subtlest">{p.source}</span>
                          {p.source === 'user' && <button className="ml-auto border-0 bg-transparent text-[0.75rem] text-foreground-subtlest transition-colors hover:text-destructive" title="Uninstall" onClick={() => void window.grasp.uninstallPlugin(p.name).then(props.onPluginsChanged)}>✕</button>}
                        </div>
                        <div className="text-[0.8125rem] text-foreground-subtle">
                          {p.description || '(no description)'}
                          {p.hasSkills && <span className="ml-1.5 rounded-full border border-border px-1.5 text-[0.625rem] text-foreground-subtlest">skills</span>}
                          {p.mcpCount > 0 && <span className="ml-1 rounded-full border border-border px-1.5 text-[0.625rem] text-foreground-subtlest">{p.mcpCount} mcp</span>}
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <input className={`${inputCls} flex-1`} placeholder="git URL (https://…/plugin.git)" value={pluginUrl} onChange={(e) => setPluginUrl(e.target.value)} spellCheck={false} />
                  <button className={btnPrimary} disabled={!pluginUrl.trim()} onClick={() => { void window.grasp.installPlugin(pluginUrl.trim()).then((r) => { if (r.ok) { setPluginUrl(''); setPluginMsg(`installed ${r.name}`) } else setPluginMsg(r.error ?? 'install failed'); props.onPluginsChanged(); setTimeout(() => setPluginMsg(''), 3000) }) }}>Install</button>
                </div>
                {pluginMsg && <div className="mt-1.5 text-[0.75rem] text-foreground-subtlest">{pluginMsg}</div>}
              </div>
            )}
            {/* Commands */}
            {section === 'commands' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">Commands {revealBtn('commands')}</div>
                {note(<>Slash commands the composer shows when you type <code className={codeCls}>/</code>.</>)}
                {props.commands.length === 0 ? <div className="py-4 text-[0.8125rem] text-foreground-subtlest">No commands.</div> : (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {props.commands.map((c) => (
                      <Card key={c.name}>
                        <div className="flex items-center gap-2">
                          <span className="text-[0.8125rem] font-semibold text-foreground">/{c.name}</span>
                          {c.skills && <span className="rounded-full border border-border px-1.5 text-[0.625rem] text-foreground-subtlest">skill: {c.skills}</span>}
                        </div>
                        <div className="text-[0.8125rem] text-foreground-subtle">{(c.description || '(no description)').slice(0, 180)}</div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Keybindings */}
            {section === 'keybindings' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">Keybindings {revealBtn('keybindings')}</div>
                {note(<>Edit <code className={codeCls}>~/.grasp/keybindings.json</code>. <code className={codeCls}>mod+</code> = Cmd/Ctrl.</>)}
                <div className="mt-2 flex flex-col gap-1.5">
                  {Object.entries(props.keybinds).map(([action, chord]) => (
                    <Card key={action}>
                      <div className="flex items-center gap-2">
                        <span className="text-[0.8125rem] font-semibold text-foreground">{action}</span>
                        <span className="ml-auto rounded-full border border-border bg-tag px-2 py-0.5 font-mono text-[0.75rem] text-foreground-subtle">{chord}</span>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
            {/* Hooks */}
            {section === 'hooks' && (
              <div>
                <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-foreground-subtlest">Hooks</div>
                {note(<>Run shell commands at lifecycle events. Edit <code className={codeCls}>~/.grasp/hooks.json</code> or <code className={codeCls}>.grasp/hooks.json</code> in the project. Events: <code className={codeCls}>UserPromptSubmit</code>, <code className={codeCls}>PreToolUse</code> (may deny a tool), <code className={codeCls}>PostToolUse</code>, <code className={codeCls}>Stop</code>. Each command receives a JSON context on stdin.</>)}
                {hooksList.length === 0 ? <div className="py-4 text-[0.8125rem] text-foreground-subtlest">No hooks configured.</div> : (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {hooksList.map((h, i) => (
                      <Card key={i}>
                        <div className="flex items-center gap-2">
                          <span className="text-[0.8125rem] font-semibold text-foreground">{h.event}</span>
                          {h.match && <span className="rounded-full border border-border px-1.5 text-[0.625rem] text-foreground-subtlest">{h.match}</span>}
                          {h.timeout != null && <span className="ml-auto rounded-full bg-tag px-1.5 text-[0.625rem] text-foreground-subtlest">{h.timeout}s</span>}
                        </div>
                        <div className="truncate text-[0.8125rem] text-foreground-subtlest font-mono">{h.command}</div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
