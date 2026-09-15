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
  rejectChangeset: (id) => ipcRenderer.invoke('changeset:reject', id),
  // —— T-S2-06 版本历史与线性回溯 ——
  listVersions: (fileId) => ipcRenderer.invoke('version:list', fileId),
  getVersionDiff: (versionId) => ipcRenderer.invoke('version:diff', versionId),
  restoreVersion: (versionId) => ipcRenderer.invoke('version:restore', versionId),
  // —— T-S2-05A 手动微调与外部编辑感知 ——
  getParagraphs: (fileId) => ipcRenderer.invoke('file:getParagraphs', fileId),
  createManualChangeset: (fileId, editedParagraphs) =>
    ipcRenderer.invoke('manual:createChangeset', fileId, editedParagraphs),
  listExternalDetections: () => ipcRenderer.invoke('external:listDetected'),
  getExternalDiff: (fileId) => ipcRenderer.invoke('external:getDiff', fileId),
  acceptExternalChange: (fileId) => ipcRenderer.invoke('external:accept', fileId),
  ignoreExternalChange: (fileId) => ipcRenderer.invoke('external:ignore', fileId),
  scanExternalChanges: () => ipcRenderer.invoke('external:scan')
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
