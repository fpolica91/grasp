import { contextBridge, ipcRenderer } from 'electron'
import type { ChatMessage, GraspApi, ObserveParams } from '../shared/types'

const api: GraspApi = {
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke('grasp:chat', messages),
  observe: (params: ObserveParams) => ipcRenderer.invoke('grasp:observe', params)
}

contextBridge.exposeInMainWorld('grasp', api)
