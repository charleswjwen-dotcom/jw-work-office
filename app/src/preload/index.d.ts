import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcApi } from '../shared/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    api: IpcApi
  }
}
