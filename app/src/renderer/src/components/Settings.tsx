// Settings — API keys per provider (stored in the safeStorage vault, namespaced), and
// appearance. Closes the S2 gap: an OpenAI key can be added entirely in-app, which flips
// the OpenAI backend to available without an env var.
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

export function Settings(props: { theme: Theme; onTheme: (t: Theme) => void; onKeysChanged: () => void; skills: { name: string; description: string; source: string; enabled: boolean }[]; onSkillsChanged: () => void; mcpServers: Record<string, { command: string; args?: string[] }>; onMcpChanged: () => void; plugins: { name: string; description: string; source: 'user' | 'project'; hasSkills: boolean; mcpCount: number }[]; onPluginsChanged: () => void; onClose: () => void }): React.JSX.Element {
  const [mcpName, setMcpName] = useState('')
  const [mcpCmd, setMcpCmd] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [pluginUrl, setPluginUrl] = useState('')
  const [pluginMsg, setPluginMsg] = useState('')
  return (
    <div className="gate-overlay" onClick={props.onClose}>
      <div className="gate settings" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <h2>Settings</h2>
          <button className="head-icon" onClick={props.onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="set-section">
          <div className="eyebrow">API keys</div>
          <p className="set-note">Stored encrypted in your OS keychain (safeStorage) — never written in plaintext.</p>
          {PROVIDERS.map((p) => (
            <KeyRow key={p.id} provider={p.id} label={p.label} hint={p.hint} onSaved={props.onKeysChanged} />
          ))}
        </div>

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

        <div className="set-section">
          <div className="eyebrow">Skills</div>
          <p className="set-note">
            Reusable instructions the agent loads via <code>use_skill</code>. Install one in <code>~/.grasp/skills</code> or{' '}
            <code>.grasp/skills</code> — a directory with <code>SKILL.md</code> (may bundle <code>references/</code>,{' '}
            <code>scripts/</code>) or a flat <code>.md</code>.
          </p>
          {props.skills.length === 0 ? (
            <div className="set-empty">No skills found in this project.</div>
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

        <div className="set-section">
          <div className="eyebrow">MCP servers</div>
          <p className="set-note">
            External stdio tool servers the agent can call. Saved to <code>~/.grasp/mcp.json</code>; their tools appear on the next turn.
          </p>
          {Object.keys(props.mcpServers).length === 0 ? (
            <div className="set-empty">No MCP servers configured.</div>
          ) : (
            <div className="set-skills">
              {Object.entries(props.mcpServers).map(([name, s]) => (
                <div className="set-skill" key={name}>
                  <div className="set-skill-head">
                    <span className="set-skill-name">{name}</span>
                    <span className="set-skill-src user">mcp</span>
                  </div>
                  <div className="set-skill-desc">
                    <code>{s.command}{s.args?.length ? ' ' + s.args.join(' ') : ''}</code>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="set-mcp-add">
            <input className="mcp-name" placeholder="name" value={mcpName} onChange={(e) => setMcpName(e.target.value)} spellCheck={false} />
            <input className="mcp-cmd" placeholder="command (e.g. npx)" value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} spellCheck={false} />
            <input className="mcp-args" placeholder="args" value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} spellCheck={false} />
            <button
              className="btn sm primary"
              disabled={!mcpName.trim() || !mcpCmd.trim()}
              onClick={() => {
                void window.grasp.saveMcpServer(mcpName.trim(), mcpCmd.trim(), mcpArgs).then(props.onMcpChanged)
                setMcpName('')
                setMcpCmd('')
                setMcpArgs('')
              }}
            >
              Add
            </button>
          </div>
        </div>

        <div className="set-section">
          <div className="eyebrow">Plugins</div>
          <p className="set-note">
            Distribution units that bundle skills (and optionally an MCP server). Install one from a git URL, or drop a dir in <code>~/.grasp/plugins/&lt;name&gt;/</code>.
          </p>
          {props.plugins.length === 0 ? (
            <div className="set-empty">No plugins installed.</div>
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
      </div>
    </div>
  )
}
