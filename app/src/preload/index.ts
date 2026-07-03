import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AgentTurn, ChatMessage, GraspApi, ObserveParams } from '../shared/types'

const api: GraspApi = {
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke('grasp:chat', messages),
  observe: (params: ObserveParams) => ipcRenderer.invoke('grasp:observe', params),
  agent: (turn: AgentTurn) => ipcRenderer.invoke('grasp:agent', turn),
  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const listener = (_e: unknown, event: AgentEvent): void => cb(event)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  }
}

contextBridge.exposeInMainWorld('grasp', api)
