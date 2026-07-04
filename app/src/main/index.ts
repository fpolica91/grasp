import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
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
import { observe, fuzz } from './engine'
import { runAgent, listBackends } from './agent'
import { hasKey, setKey } from './vault'
import { listSessions, saveSession, deleteSession } from './sessions'
import { listWorkflows, saveWorkflow, deleteWorkflow } from './workflows'
import { resolveApproval } from './approvals'
import { listProjects, openFolder, newProject, rememberProject } from './projects'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from './terminal'
import { listTree, readWorkspaceFile, writeWorkspaceFile, fileDiff } from './files'
import type { AgentTurn, ChatMessage, FuzzParams, ObserveParams, SessionRecord, WorkflowRecord } from '../shared/types'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    backgroundColor: '#0e1116',
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
  ipcMain.handle('grasp:observe', (_e, params: ObserveParams) => observe(params))
  ipcMain.handle('grasp:fuzz', (_e, params: FuzzParams) => fuzz(params))
  ipcMain.handle('grasp:agent', (e, turn: AgentTurn) => runAgent(e.sender, turn))
  ipcMain.handle('grasp:keyStatus', (_e, provider?: string) => hasKey(provider))
  ipcMain.handle('grasp:setKey', (_e, key: string, provider?: string) => setKey(key, provider))
  ipcMain.handle('grasp:defaultWorkspace', () => {
    const w = defaultWorkspace()
    rememberProject(w)
    return w
  })
  ipcMain.handle('grasp:projects', () => listProjects())
  ipcMain.handle('grasp:openFolder', () => openFolder())
  ipcMain.handle('grasp:newProject', (_e, name: string) => newProject(name))
  ipcMain.handle('grasp:backends', () => listBackends())
  ipcMain.handle('grasp:sessions', () => listSessions())
  ipcMain.handle('grasp:saveSession', (_e, rec: SessionRecord) => saveSession(rec))
  ipcMain.handle('grasp:deleteSession', (_e, id: string) => deleteSession(id))
  ipcMain.handle('grasp:approve', (_e, id: string, ok: boolean) => resolveApproval(id, ok))
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
