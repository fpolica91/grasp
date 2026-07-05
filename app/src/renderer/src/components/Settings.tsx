// Settings — a sectioned modal (left-rail nav + content). API keys per provider (stored in the
// safeStorage vault, namespaced), appearance, skills, MCP servers, and plugins. The rail is the
// fix for the UX gap where MCP/Plugins were buried at the bottom of one long scroll.
import { useEffect, useState } from 'react'
import type { Theme } from './Sidebar'

const PROVIDERS: { id: string; label: string; hint: string }[] = [
  { id: 'glm', label: 'GLM (Z.ai)', hint: 'z.ai API key — powers glm-4.6 / glm-5.2' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-… (or any OpenAI-compatible key)' }
]

const THEMES: { id: Theme; label: string }[] = [
  { id: 'graphite', label: 'Graphite' },
  { id: 'carbon', label: 'Carbon' },
  { id: 'daylight', label: 'Daylight' }
]

const SECTIONS = [
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'keys', label: 'API keys' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'commands', label: 'Commands' },
  { id: 'keybindings', label: 'Keybindings' }
] as const
type Section = (typeof SECTIONS)[number]['id']

// Curated MCP server catalog — one-click install (npx -y). Ships with the app; no network
// marketplace needed. Servers marked envHint need an API key (edit ~/.grasp/mcp.json after install).
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

function KeyRow({ provider, label, hint, onSaved }: { provider: string; label: string; hint: string; onSaved: () => void }): React.JSX.Element {
  const [has, setHas] = useState(false)
  const [val, setVal] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void window.grasp.keyStatus(provider).then(setHas)
  }, [provider])
  const save = async (): Promise<void> => {
    const r = await window.grasp.setKey(val.trim(), provider)
    if (r.ok) {
      setHas(true)
      setVal('')
      setMsg(r.warning ?? 'saved')
      onSaved()
    } else {
      setMsg(r.error ?? 'failed')
    }
    setTimeout(() => setMsg(''), 2500)
  }
  return (
    <div className="set-key">
      <div className="set-key-head">
        <span className="set-key-label">{label}</span>
        <span className={`set-key-dot${has ? ' on' : ''}`}>{has ? 'key set' : 'no key'}</span>
      </div>
      <div className="set-key-row">
        <input
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && val.trim()) void save()
          }}
          placeholder={has ? 'replace key…' : 'paste key…'}
          spellCheck={false}
        />
        <button className="btn sm primary" disabled={!val.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
      <div className="set-key-hint">
        {hint}
        {msg && <span className="set-key-msg"> · {msg}</span>}
      </div>
    </div>
  )
}

export function Settings(props: { theme: Theme; onTheme: (t: Theme) => void; onKeysChanged: () => void; skills: { name: string; description: string; source: string; enabled: boolean }[]; onSkillsChanged: () => void; mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>; onMcpChanged: () => void; plugins: { name: string; description: string; source: 'user' | 'project'; hasSkills: boolean; mcpCount: number }[]; onPluginsChanged: () => void; commands: { name: string; description: string; skills?: string }[]; keybinds: Record<string, string>; workspace: string; onClose: () => void }): React.JSX.Element {
  const [section, setSection] = useState<Section>('marketplace')
  const [mcpName, setMcpName] = useState('')
  const [mcpCmd, setMcpCmd] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpEnv, setMcpEnv] = useState('')
  const [mcpStatusList, setMcpStatusList] = useState<{ name: string; ok: boolean; error?: string; toolCount: number }[]>([])
  const [pluginUrl, setPluginUrl] = useState('')
  const [pluginMsg, setPluginMsg] = useState('')
  useEffect(() => {
    if (section === 'mcp' && props.workspace) void window.grasp.mcpStatus(props.workspace).then(setMcpStatusList)
  }, [section, props.workspace, props.mcpServers])
  return (
    <div className="gate-overlay" onClick={props.onClose}>
      <div className="gate settings" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <h2>Settings</h2>
          <button className="head-icon" onClick={props.onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={`set-nav-item${section === s.id ? ' on' : ''}`} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
          </nav>
          <div className="set-content">
            {section === 'marketplace' && (
              <div className="set-section">
                <div className="eyebrow">MCP Marketplace</div>
                <p className="set-note">One-click install popular MCP tool servers. They run via <code>npx</code> and appear as agent tools on the next turn. Servers marked “needs key” require an API key — edit <code>~/.grasp/mcp.json</code> after install.</p>
                <div className="mcp-grid">
                  {MCP_CATALOG.map((item) => {
                    const installed = item.name in props.mcpServers
                    return (
                      <div className={`mcp-card${installed ? ' installed' : ''}`} key={item.name}>
                        <div className="mcp-card-head">
                          <span className="mcp-card-name">{item.name}</span>
                          {item.envHint && <span className="set-tag">needs key</span>}
                        </div>
                        <div className="mcp-card-desc">{item.desc}</div>
                        <code className="mcp-card-pkg">{item.pkg}</code>
                        <button
                          className={`btn sm ${installed ? '' : 'primary'}`}
                          disabled={installed}
                          onClick={() =>
                            void window.grasp
                              .saveMcpServer(
                                item.name,
                                'npx',
                                `-y ${item.pkg}${item.args ? ' ' + item.args : ''}`,
                                item.envHint ? `${item.envHint}=` : ''
                              )
                              .then(props.onMcpChanged)
                          }
                        >
                          {installed ? '✓ Installed' : 'Install'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {section === 'keys' && (
              <div className="set-section">
                <div className="eyebrow">API keys</div>
                <p className="set-note">Stored encrypted in your OS keychain (safeStorage) — never written in plaintext.</p>
                {PROVIDERS.map((p) => (
                  <KeyRow key={p.id} provider={p.id} label={p.label} hint={p.hint} onSaved={props.onKeysChanged} />
                ))}
              </div>
            )}

            {section === 'appearance' && (
              <div className="set-section">
                <div className="eyebrow">Appearance</div>
                <div className="set-themes">
                  {THEMES.map((t) => (
                    <button key={t.id} className={`set-theme${props.theme === t.id ? ' on' : ''}`} onClick={() => props.onTheme(t.id)}>
                      <span className={`theme-dot ${t.id}`} />
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {section === 'skills' && (
              <div className="set-section">
                <div className="eyebrow">Skills <button className="set-reveal" onClick={() => void window.grasp.revealInFiles('skills')}>reveal in files</button></div>
                <p className="set-note">
                  Reusable instructions the agent loads via <code>use_skill</code>. Install one in <code>~/.grasp/skills</code> or{' '}
                  <code>.grasp/skills</code> — a directory with <code>SKILL.md</code> (may bundle <code>references/</code>,{' '}
                  <code>scripts/</code>) or a flat <code>.md</code>.
                </p>
                {props.skills.length === 0 ? (
                  <div className="set-empty">
                    No skills yet. grasp auto-seeds a few the first time it runs (<code>fuzz-diff</code>, <code>trace-flow</code>,
                    <code>observe-change</code>, <code>skill-creator</code>) — the agent loads them via <code>use_skill</code>.
                    Add your own as a directory with a <code>SKILL.md</code>.
                  </div>
                ) : (
                  <div className="set-skills">
                    {props.skills.map((s) => (
                      <div className={`set-skill${s.enabled ? '' : ' off'}`} key={s.name + '|' + s.source}>
                        <div className="set-skill-head">
                          <span className="set-skill-name">{s.name}</span>
                          <span className={`set-skill-src ${s.source}`}>{s.source}</span>
                          <button
                            className={`set-skill-toggle${s.enabled ? ' on' : ''}`}
                            title={s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                            onClick={() => void window.grasp.setSkillEnabled(s.name, !s.enabled).then(props.onSkillsChanged)}
                          >
                            {s.enabled ? 'on' : 'off'}
                          </button>
                        </div>
                        <div className="set-skill-desc">{(s.description || '(no description)').slice(0, 180)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {section === 'mcp' && (
              <div className="set-section">
                <div className="eyebrow">MCP servers <button className="set-reveal" onClick={() => void window.grasp.revealInFiles('mcp')}>reveal in files</button></div>
                <p className="set-note">
                  External stdio tool servers the agent can call. Saved to <code>~/.grasp/mcp.json</code>; their tools appear on the next turn.
                </p>
                {Object.keys(props.mcpServers).length === 0 ? (
                  <div className="set-empty">
                    No MCP servers configured. Add one above — e.g. command <code>npx</code>, args{' '}
                    <code>-y @modelcontextprotocol/server-filesystem .</code> — or edit <code>~/.grasp/mcp.json</code>{' '}
                    (use “reveal in files”).
                  </div>
                ) : (
                  <div className="set-skills">
                    {Object.entries(props.mcpServers).map(([name, s]) => {
                      const st = mcpStatusList.find((x) => x.name === name)
                      return (
                        <div className="set-skill" key={name}>
                          <div className="set-skill-head">
                            <span className="set-skill-name">{name}</span>
                            <span className={`set-skill-src user${st?.ok === false ? ' err' : ''}`}>
                              {st ? (st.ok ? `${st.toolCount} tool${st.toolCount === 1 ? '' : 's'}` : 'failed') : 'mcp'}
                            </span>
                            <button
                              className="si-del"
                              title="Remove"
                              onClick={() => void window.grasp.deleteMcpServer(name).then(props.onMcpChanged)}
                            >
                              ✕
                            </button>
                          </div>
                          <div className="set-skill-desc">
                            <code>{s.command}{s.args?.length ? ' ' + s.args.join(' ') : ''}</code>
                            {s.env && <span className="set-tag">{Object.keys(s.env).length} env</span>}
                            {st?.error && <div className="set-mcp-err">{st.error}</div>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="set-mcp-add">
                  <input className="mcp-name" placeholder="name" value={mcpName} onChange={(e) => setMcpName(e.target.value)} spellCheck={false} />
                  <input className="mcp-cmd" placeholder="command (e.g. npx)" value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} spellCheck={false} />
                  <input className="mcp-args" placeholder={'args (quote to keep spaces: "foo bar")'} value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} spellCheck={false} />
                  <textarea
                    className="mcp-env"
                    placeholder="env: KEY=VALUE per line (optional)"
                    value={mcpEnv}
                    onChange={(e) => setMcpEnv(e.target.value)}
                    rows={1}
                    spellCheck={false}
                  />
                  <button
                    className="btn sm primary"
                    disabled={!mcpName.trim() || !mcpCmd.trim()}
                    onClick={() => {
                      void window.grasp.saveMcpServer(mcpName.trim(), mcpCmd.trim(), mcpArgs, mcpEnv).then(props.onMcpChanged)
                      setMcpName('')
                      setMcpCmd('')
                      setMcpArgs('')
                      setMcpEnv('')
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            {section === 'plugins' && (
              <div className="set-section">
                <div className="eyebrow">Plugins <button className="set-reveal" onClick={() => void window.grasp.revealInFiles('plugins')}>reveal in files</button></div>
                <p className="set-note">
                  Distribution units that bundle skills (and optionally an MCP server). Install one from a git URL, or drop a dir in <code>~/.grasp/plugins/&lt;name&gt;/</code>.
                </p>
                {props.plugins.length === 0 ? (
                  <div className="set-empty">
                    No plugins installed. Install one from a git URL above, or drop a directory in{' '}
                    <code>~/.grasp/plugins/&lt;name&gt;/</code> with a <code>plugin.json</code> and a <code>skills/</code>{' '}
                    folder. A plugin bundles skills (and optionally an MCP server).
                  </div>
                ) : (
                  <div className="set-skills">
                    {props.plugins.map((p) => (
                      <div className="set-skill" key={p.name + '|' + p.source}>
                        <div className="set-skill-head">
                          <span className="set-skill-name">{p.name}</span>
                          <span className={`set-skill-src ${p.source}`}>{p.source}</span>
                          {p.source === 'user' && (
                            <button
                              className="si-del"
                              title="Uninstall"
                              onClick={() => void window.grasp.uninstallPlugin(p.name).then(props.onPluginsChanged)}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <div className="set-skill-desc">
                          {p.description || '(no description)'}
                          {p.hasSkills && <span className="set-tag">skills</span>}
                          {p.mcpCount > 0 && <span className="set-tag">{p.mcpCount} mcp</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="set-mcp-add">
                  <input
                    className="mcp-cmd"
                    placeholder="git URL (https://…/plugin.git)"
                    value={pluginUrl}
                    onChange={(e) => setPluginUrl(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    className="btn sm primary"
                    disabled={!pluginUrl.trim()}
                    onClick={() => {
                      void window.grasp.installPlugin(pluginUrl.trim()).then((r) => {
                        if (r.ok) {
                          setPluginUrl('')
                          setPluginMsg(`installed ${r.name}`)
                        } else setPluginMsg(r.error ?? 'install failed')
                        props.onPluginsChanged()
                        setTimeout(() => setPluginMsg(''), 3000)
                      })
                    }}
                  >
                    Install
                  </button>
                </div>
                {pluginMsg && <div className="set-key-hint">{pluginMsg}</div>}
              </div>
            )}

            {section === 'commands' && (
              <div className="set-section">
                <div className="eyebrow">Commands <button className="set-reveal" onClick={() => void window.grasp.revealInFiles('commands')}>reveal in files</button></div>
                <p className="set-note">Slash commands the composer shows when you type <code>/</code>. A <code>commands/*.md</code> with a <code>skills:</code> key auto-loads a skill.</p>
                {props.commands.length === 0 ? (
                  <div className="set-empty">No commands. Drop a <code>.md</code> in <code>~/.grasp/commands/</code>.</div>
                ) : (
                  <div className="set-skills">
                    {props.commands.map((c) => (
                      <div className="set-skill" key={c.name}>
                        <div className="set-skill-head">
                          <span className="set-skill-name">/{c.name}</span>
                          {c.skills && <span className="set-tag">skill: {c.skills}</span>}
                        </div>
                        <div className="set-skill-desc">{(c.description || '(no description)').slice(0, 180)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {section === 'keybindings' && (
              <div className="set-section">
                <div className="eyebrow">Keybindings <button className="set-reveal" onClick={() => void window.grasp.revealInFiles('keybindings')}>reveal in files</button></div>
                <p className="set-note">Rebindable chords — edit <code>~/.grasp/keybindings.json</code> (e.g. <code>{`{"new-session":"mod+shift+n"}`}</code>). <code>mod+</code> = Cmd on mac, Ctrl elsewhere.</p>
                <div className="set-skills">
                  {Object.entries(props.keybinds).map(([action, chord]) => (
                    <div className="set-skill" key={action}>
                      <div className="set-skill-head">
                        <span className="set-skill-name">{action}</span>
                        <span className="set-skill-src user">
                          <kbd>{chord}</kbd>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
