import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { chat } from './model'
import { observe, fuzz } from './engine'
import { runAgent } from './agent'
import { hasKey, setKey } from './vault'
import type { AgentTurn, ChatMessage, FuzzParams, ObserveParams } from '../shared/types'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    backgroundColor: '#0f1216',
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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
