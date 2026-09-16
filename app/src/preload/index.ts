import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ChatStreamEvent, IpcApi } from '../shared/ipc'

// preload 白名单桥接：每个方法都是对主进程 IPC channel 的窄封装。
// 渲染层拿到的 window.api 只有这些方法，碰不到 Node/fs/ipcRenderer 全量能力（安全红线）。
const api: IpcApi = {
  ping: () => ipcRenderer.invoke('ping'),
  importWord: () => ipcRenderer.invoke('file:importWord'),
  listFiles: (workspaceId) => ipcRenderer.invoke('file:list', workspaceId),
  searchFiles: (query) => ipcRenderer.invoke('file:search', query),
  // —— T-S2-08 右栏 Word 预览：只回传主进程消毒后的白名单 HTML ——
  getPreviewHtml: (fileId) => ipcRenderer.invoke('preview:getHtml', fileId),
  chatSend: (fileId, prompt, turnId) =>
    ipcRenderer.invoke('chat:send', fileId, prompt, turnId),
  // —— T-S2-08③ 流式事件：主进程单向推送，退订函数供渲染层 effect cleanup ——
  onChatStream: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: ChatStreamEvent): void => {
      listener(ev)
    }
    ipcRenderer.on('chat:stream', handler)
    return () => {
      ipcRenderer.removeListener('chat:stream', handler)
    }
  },
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
  scanExternalChanges: () => ipcRenderer.invoke('external:scan'),
  // —— T-S2-07 模型配置与密钥管理（渲染层只拿掩码视图）——
  listModelConfigs: () => ipcRenderer.invoke('model:list'),
  saveModelConfig: (input) => ipcRenderer.invoke('model:save', input),
  deleteModelConfig: (id) => ipcRenderer.invoke('model:delete', id),
  setDefaultModelConfig: (id) => ipcRenderer.invoke('model:setDefault', id),
  getProviderStatus: () => ipcRenderer.invoke('model:status')
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
