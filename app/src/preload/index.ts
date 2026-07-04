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
  keyStatus: () => ipcRenderer.invoke('grasp:keyStatus'),
  setKey: (key: string) => ipcRenderer.invoke('grasp:setKey', key),
  defaultWorkspace: () => ipcRenderer.invoke('grasp:defaultWorkspace'),
  backends: () => ipcRenderer.invoke('grasp:backends'),
  sessions: () => ipcRenderer.invoke('grasp:sessions'),
  saveSession: (rec: SessionRecord) => ipcRenderer.invoke('grasp:saveSession', rec),
  deleteSession: (id: string) => ipcRenderer.invoke('grasp:deleteSession', id),
  approve: (id: string, ok: boolean) => ipcRenderer.invoke('grasp:approve', id, ok),
  workflows: () => ipcRenderer.invoke('grasp:workflows'),
  saveWorkflow: (rec: WorkflowRecord) => ipcRenderer.invoke('grasp:saveWorkflow', rec),
  deleteWorkflow: (id: string) => ipcRenderer.invoke('grasp:deleteWorkflow', id)
}

contextBridge.exposeInMainWorld('grasp', api)
