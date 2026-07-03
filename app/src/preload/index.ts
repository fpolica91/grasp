import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AgentTurn, ChatMessage, FuzzParams, GraspApi, ObserveParams } from '../shared/types'

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
  backends: () => ipcRenderer.invoke('grasp:backends')
}

contextBridge.exposeInMainWorld('grasp', api)
