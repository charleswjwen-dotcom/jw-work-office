import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { IpcApi } from '../shared/ipc'

// preload 白名单桥接：每个方法都是对主进程 IPC channel 的窄封装。
// 渲染层拿到的 window.api 只有这些方法，碰不到 Node/fs/ipcRenderer 全量能力（安全红线）。
const api: IpcApi = {
  ping: () => ipcRenderer.invoke('ping'),
  importWord: () => ipcRenderer.invoke('file:importWord'),
  listFiles: (workspaceId) => ipcRenderer.invoke('file:list', workspaceId),
  searchFiles: (query) => ipcRenderer.invoke('file:search', query),
  chatSend: (fileId, prompt) => ipcRenderer.invoke('chat:send', fileId, prompt),
  listPendingChangesets: () => ipcRenderer.invoke('changeset:listPending'),
  acceptChangeset: (id, acceptedChangeIds) =>
    ipcRenderer.invoke('changeset:accept', id, acceptedChangeIds),
  rejectChangeset: (id) => ipcRenderer.invoke('changeset:reject', id)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error contextIsolation 关闭时的回退路径
  window.electron = electronAPI
  // @ts-expect-error contextIsolation 关闭时的回退路径
  window.api = api
}
