import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'

// The default home for projects the agent builds — NEVER grasp's own source dir.
// Override with GRASP_WORKSPACE.
function defaultWorkspace(): string {
  if (process.env.GRASP_WORKSPACE) return process.env.GRASP_WORKSPACE
  const root = join(homedir(), 'GraspProjects')
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    /* fall through; the field is still editable */
  }
  return root
}
import { chat } from './model'
import { oneShot } from './oneshot'
import { gitGraph, gitAction } from './git'
import { readWiki, generateWiki } from './wiki'
import { observe, fuzz } from './engine'
import { runAgent, listBackends, stopAgent, steerAgent } from './agent'
import { hasKey, setKey } from './vault'
import { listSessions, saveSession, deleteSession, forkSession, renameSession } from './sessions'
import { listWorkflows, saveWorkflow, deleteWorkflow } from './workflows'
import { resolveApproval, resolveElicitation } from './approvals'
import { flowNow, clearMcpCache, mcpStatus } from './backends/tools'
import { loadMcpConfig, saveMcpServer, deleteMcpServer } from './backends/mcp'
import { listPlugins, installPlugin, uninstallPlugin } from './plugins'
import { listProjects, openFolder, newProject, rememberProject } from './projects'
import { listSkills, ensureDefaultSkills, setSkillEnabled } from './skills'
import { startTestHarness } from './testharness'
import { listCommands } from './commands'
import { loadKeybindings } from './keybinds'
import { detectApps, launchApp } from './launcher'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from './terminal'
import { listTree, readWorkspaceFile, writeWorkspaceFile, fileDiff } from './files'
import type { AgentTurn, ChatMessage, FuzzParams, ObserveParams, SessionRecord, WorkflowRecord } from '../shared/types'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    backgroundColor: '#161616',
    title: 'grasp',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      webviewTag: true // the in-app browser pane (S4c)
    }
  })

  // electron-vite dev server URL, or the built file
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  ipcMain.handle('grasp:chat', (_e, messages: ChatMessage[]) => chat(messages))
  ipcMain.handle('grasp:oneShot', (_e, opts: { backend: string; model?: string; system: string; user: string; maxTokens?: number }) => oneShot(opts))
  ipcMain.handle('grasp:gitGraph', (_e, workspace: string) => gitGraph(workspace))
  ipcMain.handle('grasp:gitAction', (_e, workspace: string, op: 'fetch' | 'pull' | 'push' | 'stageAll' | 'commit' | 'checkout' | 'newBranch' | 'merge' | 'rebase', arg?: string) => gitAction(workspace, op, arg))
  ipcMain.handle('grasp:wikiRead', (_e, workspace: string) => readWiki(workspace))
  ipcMain.handle('grasp:wikiGenerate', (_e, workspace: string, backend: string, model?: string) => generateWiki(workspace, backend, model))
  ipcMain.handle('grasp:observe', (_e, params: ObserveParams) => observe(params))
  ipcMain.handle('grasp:fuzz', (_e, params: FuzzParams) => fuzz(params))
  ipcMain.handle('grasp:agent', (e, turn: AgentTurn) => runAgent(e.sender, turn))
  ipcMain.handle('grasp:steer', (_e, text: string) => steerAgent(text))
  ipcMain.handle('grasp:keyStatus', (_e, provider?: string) => hasKey(provider))
  ipcMain.handle('grasp:setKey', (_e, key: string, provider?: string) => setKey(key, provider))
  ipcMain.handle('grasp:defaultWorkspace', () => {
    const w = defaultWorkspace()
    rememberProject(w)
    return w
  })
  ensureDefaultSkills()
  // Dev-only test harness: lets an external agent drive events/tools and capture real
  // window screenshots, so the human is never the test rig (127.0.0.1 + file bridge).
  if (!app.isPackaged || process.env.GRASP_TEST === '1')
    startTestHarness(() => BrowserWindow.getAllWindows()[0] ?? null)
  ipcMain.handle('grasp:skills', (_e, workspace: string) => listSkills(workspace))
  ipcMain.handle('grasp:setSkillEnabled', (_e, name: string, enabled: boolean) => setSkillEnabled(name, enabled))
  ipcMain.handle('grasp:commands', (_e, workspace: string) => listCommands(workspace))
  ipcMain.handle('grasp:keybindings', () => loadKeybindings())
  ipcMain.handle('grasp:mcpServers', (_e, workspace: string) => loadMcpConfig(workspace))
  ipcMain.handle('grasp:plugins', (_e, workspace: string) => listPlugins(workspace))
  ipcMain.handle('grasp:installPlugin', (_e, url: string) => {
    const r = installPlugin(url)
    clearMcpCache() // a plugin may bundle MCP servers -> re-read on the next turn
    return r
  })
  ipcMain.handle('grasp:uninstallPlugin', (_e, name: string) => {
    const r = uninstallPlugin(name)
    clearMcpCache()
    return r
  })
  ipcMain.handle('grasp:saveMcpServer', (_e, name: string, command: string, args: string, env: string) => {
    // quoted-aware tokenizer so an arg with spaces survives: -y "foo bar" -> ['-y','foo bar']
    const toks = (s: string): string[] => {
      const out: string[] = []
      for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim())
      return out.filter(Boolean)
    }
    const envObj: Record<string, string> = {}
    for (const line of (env || '').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) envObj[line.slice(0, i).trim()] = line.slice(i + 1)
    }
    const cfg = {
      command,
      ...(toks(args).length ? { args: toks(args) } : {}),
      ...(Object.keys(envObj).length ? { env: envObj } : {})
    }
    saveMcpServer(name, cfg)
    clearMcpCache()
  })
  ipcMain.handle('grasp:deleteMcpServer', (_e, name: string) => {
    const r = deleteMcpServer(name)
    clearMcpCache()
    return r
  })
  ipcMain.handle('grasp:mcpStatus', (_e, workspace: string) => mcpStatus(workspace))
  ipcMain.handle('grasp:projects', () => listProjects())
  ipcMain.handle('grasp:openFolder', () => openFolder())
  // Reveal a ~/.grasp surface in the OS file manager. skills/plugins/commands open as dirs;
  // mcp selects mcp.json; a missing path falls back to opening ~/.grasp so the user sees where
  // to create it.
  ipcMain.handle('grasp:detectApps', () => detectApps())
  ipcMain.handle('grasp:openInApp', (_e, appId: string, ws: string) => launchApp(appId, ws))
  ipcMain.handle('grasp:revealInFiles', (_e, key: string) => {
    const root = join(homedir(), '.grasp')
    const file = key === 'mcp' ? 'mcp.json' : key === 'keybindings' ? 'keybindings.json' : key
    const p = join(root, file)
    try {
      if (existsSync(p) && statSync(p).isDirectory()) void shell.openPath(p)
      else if (existsSync(p)) void shell.showItemInFolder(p)
      else void shell.openPath(root)
    } catch {
      /* ignore — best-effort reveal */
    }
  })
  ipcMain.handle('grasp:newProject', (_e, name: string) => newProject(name))
  ipcMain.handle('grasp:backends', () => listBackends())
  ipcMain.handle('grasp:sessions', () => listSessions())
  ipcMain.handle('grasp:saveSession', (_e, rec: SessionRecord) => saveSession(rec))
  ipcMain.handle('grasp:deleteSession', (_e, id: string) => deleteSession(id))
  ipcMain.handle('grasp:forkSession', (_e, id: string) => forkSession(id))
  ipcMain.handle('grasp:renameSession', (_e, id: string, title: string) => renameSession(id, title))
  ipcMain.handle('grasp:approve', (_e, id: string, ok: boolean) => resolveApproval(id, ok))
  ipcMain.handle('grasp:resolveElicitation', (_e, id: string, answer: string | null) => resolveElicitation(id, answer))
  ipcMain.handle('grasp:stopAgent', () => stopAgent())
  ipcMain.handle('grasp:flowNow', (e, workspace: string) =>
    flowNow(workspace, (event) => {
      if (!e.sender.isDestroyed()) e.sender.send('agent:event', event)
    })
  )
  ipcMain.handle('grasp:workflows', () => listWorkflows())
  ipcMain.handle('grasp:saveWorkflow', (_e, rec: WorkflowRecord) => saveWorkflow(rec))
  ipcMain.handle('grasp:deleteWorkflow', (_e, id: string) => deleteWorkflow(id))
  ipcMain.on('terminal:create', (e, { id, cwd, cols, rows }) => createTerminal(e.sender, id, cwd, cols, rows))
  ipcMain.on('terminal:write', (_e, { id, data }) => writeTerminal(id, data))
  ipcMain.on('terminal:resize', (_e, { id, cols, rows }) => resizeTerminal(id, cols, rows))
  ipcMain.on('terminal:kill', (_e, { id }) => killTerminal(id))
  ipcMain.handle('grasp:listTree', (_e, workspace: string) => listTree(workspace))
  ipcMain.handle('grasp:readFile', (_e, workspace: string, rel: string) => readWorkspaceFile(workspace, rel))
  ipcMain.handle('grasp:writeFile', (_e, workspace: string, rel: string, content: string) => writeWorkspaceFile(workspace, rel, content))
  ipcMain.handle('grasp:fileDiff', (_e, workspace: string, rel: string) => fileDiff(workspace, rel))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
