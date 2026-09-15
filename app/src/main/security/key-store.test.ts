import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeyStoreService, type CryptoPort } from './key-store'

// FakeCrypto：AES-256-GCM 模拟 safeStorage（布局 iv(12) + tag(16) + 密文）。
// CryptoPort 注入式设计（架构 §3.6）的价值正在于此——vitest 的 node 环境
// 无法加载 electron，换 key 构造新实例即可模拟「OS keychain 重置后
// 旧密文不可解」的真实故障形态。
class FakeCrypto implements CryptoPort {
  constructor(private readonly key: Buffer = Buffer.alloc(32, 7)) {}

  isEncryptionAvailable(): boolean {
    return true
  }

  encrypt(plainText: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data])
  }

  decrypt(encrypted: Buffer): string {
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
      'utf-8'
    )
  }
}

// safeStorage 不可用形态（如 Linux 缺 libsecret）：拒绝一切加解密。
class UnavailableCrypto implements CryptoPort {
  isEncryptionAvailable(): boolean {
    return false
  }

  encrypt(): Buffer {
    throw new Error('encryption unavailable')
  }

  decrypt(): string {
    throw new Error('encryption unavailable')
  }
}

const PLAIN_KEY = 'sk-live-0123456789abcdefwxyz'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-keystore-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function storePath(): string {
  return join(workDir, 'api-keys.json')
}

describe('KeyStoreService（T-S2-07 加密落盘）', () => {
  it('setKey 落盘密文：文件不含明文、条目为 base64', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() })
    const ref = ks.generateRef()

    ks.setKey(ref, PLAIN_KEY)

    expect(existsSync(storePath())).toBe(true)
    const raw = readFileSync(storePath(), 'utf-8')
    expect(raw).not.toContain(PLAIN_KEY)
    expect((JSON.parse(raw) as Record<string, string>)[ref]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it('getKey 解密往返：主进程内可还原明文', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() })
    const ref = ks.generateRef()

    ks.setKey(ref, PLAIN_KEY)

    expect(ks.getKey(ref)).toBe(PLAIN_KEY)
    expect(ks.hasKey(ref)).toBe(true)
  })

  it('掩码：长密钥首尾各 4 字符；短密钥（≤8 字符）只保留首 2 字符', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() })
    const ref = ks.generateRef()
    ks.setKey(ref, PLAIN_KEY)
    expect(ks.maskForRef(ref)).toBe('sk-l****wxyz')

    ks.setKey('key-short', 'abcd1234')
    expect(ks.maskForRef('key-short')).toBe('ab****')
  })

  it('keychain 重置（换 key 解密失败）→ getKey 返回 null 而非抛出', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() })
    const ref = ks.generateRef()
    ks.setKey(ref, PLAIN_KEY)

    const rotated = new KeyStoreService({
      secureDir: workDir,
      crypto: new FakeCrypto(Buffer.alloc(32, 9))
    })

    expect(rotated.getKey(ref)).toBeNull()
  })

  it('deleteKey 删除密文条目；不存在的 ref 返回 false', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() })
    const ref = ks.generateRef()
    ks.setKey(ref, PLAIN_KEY)

    expect(ks.deleteKey(ref)).toBe(true)
    expect(ks.hasKey(ref)).toBe(false)
    expect(ks.getKey(ref)).toBeNull()

    expect(ks.deleteKey(ref)).toBe(false)
  })

  it('不存在的 ref：getKey → null、hasKey → false', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() })
    expect(ks.getKey('key-nope')).toBeNull()
    expect(ks.hasKey('key-nope')).toBe(false)
  })

  it('safeStorage 不可用时 setKey 抛 KEYSTORE_UNAVAILABLE（拒绝明文落盘）', () => {
    const ks = new KeyStoreService({ secureDir: workDir, crypto: new UnavailableCrypto() })

    expect(() => ks.setKey('key-x', PLAIN_KEY)).toThrowError(/KEYSTORE_UNAVAILABLE/)
    expect(existsSync(storePath())).toBe(false)
  })

  it('available() 透传 CryptoPort 探测结果', () => {
    expect(
      new KeyStoreService({ secureDir: workDir, crypto: new FakeCrypto() }).available()
    ).toBe(true)
    expect(
      new KeyStoreService({ secureDir: workDir, crypto: new UnavailableCrypto() }).available()
    ).toBe(false)
  })
})
