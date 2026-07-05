import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AgentTurn, ChatMessage, FuzzParams, GraspApi, ObserveParams, SessionRecord, WorkflowRecord } from '../shared/types'

const api: GraspApi = {
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke('grasp:chat', messages),
  observe: (params: ObserveParams) => ipcRenderer.invoke('grasp:observe', params),
  fuzz: (params: FuzzParams) => ipcRenderer.invoke('grasp:fuzz', params),
  agent: (turn: AgentTurn) => ipcRenderer.invoke('grasp:agent', turn),
  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const listener = (_e: unknown, event: AgentEvent): void => cb(event)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  keyStatus: (provider?: string) => ipcRenderer.invoke('grasp:keyStatus', provider),
  setKey: (key: string, provider?: string) => ipcRenderer.invoke('grasp:setKey', key, provider),
  defaultWorkspace: () => ipcRenderer.invoke('grasp:defaultWorkspace'),
  backends: () => ipcRenderer.invoke('grasp:backends'),
  sessions: () => ipcRenderer.invoke('grasp:sessions'),
  saveSession: (rec: SessionRecord) => ipcRenderer.invoke('grasp:saveSession', rec),
  deleteSession: (id: string) => ipcRenderer.invoke('grasp:deleteSession', id),
  forkSession: (id: string) => ipcRenderer.invoke('grasp:forkSession', id),
  approve: (id: string, ok: boolean) => ipcRenderer.invoke('grasp:approve', id, ok),
  flowNow: (workspace: string) => ipcRenderer.invoke('grasp:flowNow', workspace),
  stopAgent: () => ipcRenderer.invoke('grasp:stopAgent'),
  workflows: () => ipcRenderer.invoke('grasp:workflows'),
  saveWorkflow: (rec: WorkflowRecord) => ipcRenderer.invoke('grasp:saveWorkflow', rec),
  deleteWorkflow: (id: string) => ipcRenderer.invoke('grasp:deleteWorkflow', id),
  projects: () => ipcRenderer.invoke('grasp:projects'),
  skills: (workspace: string) => ipcRenderer.invoke('grasp:skills', workspace),
  setSkillEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('grasp:setSkillEnabled', name, enabled),
  commands: (workspace: string) => ipcRenderer.invoke('grasp:commands', workspace),
  keybindings: () => ipcRenderer.invoke('grasp:keybindings'),
  mcpServers: (workspace: string) => ipcRenderer.invoke('grasp:mcpServers', workspace),
  plugins: (workspace: string) => ipcRenderer.invoke('grasp:plugins', workspace),
  saveMcpServer: (name: string, command: string, args: string) => ipcRenderer.invoke('grasp:saveMcpServer', name, command, args),
  openFolder: () => ipcRenderer.invoke('grasp:openFolder'),
  newProject: (name: string) => ipcRenderer.invoke('grasp:newProject', name),
  termCreate: (id: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:create', { id, cwd, cols, rows }),
  termWrite: (id: string, data: string) => ipcRenderer.send('terminal:write', { id, data }),
  termResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  termKill: (id: string) => ipcRenderer.send('terminal:kill', { id }),
  onTermData: (cb: (id: string, data: string) => void) => {
    const l = (_e: unknown, m: { id: string; data: string }): void => cb(m.id, m.data)
    ipcRenderer.on('terminal:data', l)
    return () => ipcRenderer.removeListener('terminal:data', l)
  },
  onTermExit: (cb: (id: string, exitCode: number) => void) => {
    const l = (_e: unknown, m: { id: string; exitCode: number }): void => cb(m.id, m.exitCode)
    ipcRenderer.on('terminal:exit', l)
    return () => ipcRenderer.removeListener('terminal:exit', l)
  },
  listTree: (workspace: string) => ipcRenderer.invoke('grasp:listTree', workspace),
  readFile: (workspace: string, rel: string) => ipcRenderer.invoke('grasp:readFile', workspace, rel),
  writeFile: (workspace: string, rel: string, content: string) => ipcRenderer.invoke('grasp:writeFile', workspace, rel, content),
  fileDiff: (workspace: string, rel: string) => ipcRenderer.invoke('grasp:fileDiff', workspace, rel)
}

contextBridge.exposeInMainWorld('grasp', api)
