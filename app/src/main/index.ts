import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { chat } from './model'
import { observe, fuzz } from './engine'
import { runAgent, listBackends } from './agent'
import { hasKey, setKey } from './vault'
import { listSessions, saveSession, deleteSession } from './sessions'
import { listWorkflows, saveWorkflow, deleteWorkflow } from './workflows'
import { resolveApproval } from './approvals'
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
      contextIsolation: true
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
  ipcMain.handle('grasp:keyStatus', () => hasKey())
  ipcMain.handle('grasp:setKey', (_e, key: string) => setKey(key))
  ipcMain.handle('grasp:defaultWorkspace', () => process.env.GRASP_WORKSPACE || process.cwd())
  ipcMain.handle('grasp:backends', () => listBackends())
  ipcMain.handle('grasp:sessions', () => listSessions())
  ipcMain.handle('grasp:saveSession', (_e, rec: SessionRecord) => saveSession(rec))
  ipcMain.handle('grasp:deleteSession', (_e, id: string) => deleteSession(id))
  ipcMain.handle('grasp:approve', (_e, id: string, ok: boolean) => resolveApproval(id, ok))
  ipcMain.handle('grasp:workflows', () => listWorkflows())
  ipcMain.handle('grasp:saveWorkflow', (_e, rec: WorkflowRecord) => saveWorkflow(rec))
  ipcMain.handle('grasp:deleteWorkflow', (_e, id: string) => deleteWorkflow(id))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
