import { safeStorage } from 'electron'
import type { CryptoPort } from './key-store'

// T-S2-07 生产 CryptoPort 实现（架构 §3.6）：electron safeStorage 的唯一封装落点。
// 独立成文件是为了把 electron import 与 KeyStoreService 逻辑解耦——
// vitest（node 环境）无法加载 electron，测试注入 node:crypto FakeCrypto 即可
// 覆盖 KeyStoreService 全部行为，此文件仅由主进程装配路径引入。
export class SafeStorageCrypto implements CryptoPort {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  encrypt(plainText: string): Buffer {
    return safeStorage.encryptString(plainText)
  }

  decrypt(encrypted: Buffer): string {
    return safeStorage.decryptString(encrypted)
  }
}
