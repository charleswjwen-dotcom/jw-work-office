import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../db/atomic-write'

// —— T-S2-07 密钥加密存储（架构 §3.6 / PRD 7A.2 隐私红线）——
//
// 分层与不变量：
// 1. electron safeStorage 加解密只能在主进程（依赖 Electron 会话与 OS keychain，
//    不得迁入 Worker/Utility 进程），本模块通过 CryptoPort 端口隔离 electron
//    import——生产注入 SafeStorageCrypto（safe-storage-crypto.ts，唯一 electron
//    落点），vitest（node 环境）注入 node:crypto FakeCrypto 即可全覆盖。
// 2. 密文落盘 {secureDir}/api-keys.json（{ [ref]: base64 }，原子写：tmp→fsync→
//    rename，崩溃不留半写态）；DB model_configs.api_key_ref 只存引用——
//    明文既不进 DB 也不进日志（logger SENSITIVE_KEYS 双保险）。
// 3. 解密失败返回 null 而非抛出：OS keychain 重置/换机会让旧密文不可解，
//    上层（provider-factory）据此诚实降级 Mock，不阻断启动。

export interface CryptoPort {
  isEncryptionAvailable(): boolean
  encrypt(plainText: string): Buffer
  decrypt(encrypted: Buffer): string
}

export interface KeyStoreOptions {
  secureDir: string
  crypto: CryptoPort
}

export class KeyStoreService {
  private readonly storePath: string
  private readonly crypto: CryptoPort

  constructor({ secureDir, crypto }: KeyStoreOptions) {
    this.storePath = join(secureDir, 'api-keys.json')
    this.crypto = crypto
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable()
  }

  // 引用格式 key-<uuid>：与密文条目一一对应，DB 行只存此引用不存密文。
  generateRef(): string {
    return `key-${randomUUID()}`
  }

  setKey(ref: string, plainKey: string): void {
    // 前置拒绝（而非静默明文落盘）：safeStorage 不可用时宁可让上层报结构化错误。
    if (!this.available()) {
      throw new Error('KEYSTORE_UNAVAILABLE: 系统加密存储不可用，拒绝以明文保存 API Key')
    }
    const store = this.readStore()
    store[ref] = this.crypto.encrypt(plainKey).toString('base64')
    this.writeStore(store)
  }

  // 解密失败（keychain 重置/密文损坏）→ null：由上层诚实降级，不炸启动。
  getKey(ref: string): string | null {
    const b64 = this.readStore()[ref]
    if (!b64) return null
    try {
      return this.crypto.decrypt(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  }

  hasKey(ref: string): boolean {
    return this.readStore()[ref] !== undefined
  }

  deleteKey(ref: string): boolean {
    const store = this.readStore()
    if (store[ref] === undefined) return false
    // 重建而非动态 delete：保留其余条目原样落盘（等价语义，无 mutate 陷阱）。
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(store)) {
      if (k !== ref) next[k] = v
    }
    this.writeStore(next)
    return true
  }

  // 掩码（主进程生成，渲染层只拿结果）：sk-1a2b****wxyz 形式；
  // ≤8 字符的短密钥只保留首 2 字符，避免整体泄露。
  maskForRef(ref: string): string | null {
    const plain = this.getKey(ref)
    if (!plain) return null
    if (plain.length <= 8) return `${plain.slice(0, 2)}****`
    return `${plain.slice(0, 4)}****${plain.slice(-4)}`
  }

  private readStore(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.storePath, 'utf-8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private writeStore(store: Record<string, string>): void {
    atomicWriteFileSync(this.storePath, JSON.stringify(store, null, 2))
  }
}
