import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db/connection'
import { DataService } from '../db/data-service'
import { KeyStoreService, type CryptoPort } from '../security/key-store'
import { ModelConfigService } from './model-config-service'
import { resolveChatProvider, type ProviderStorePort } from './provider-factory'
import type {
  DbRequestMap,
  DbRequestType,
  ModelConfigRecord
} from '../../shared/db-protocol'

// FakeCrypto：AES-256-GCM 模拟 safeStorage（布局 iv(12) + tag(16) + 密文），
// 与 key-store.test.ts 同款——CryptoPort 端口隔离 electron import（§3.6），
// node 环境即可覆盖 ModelConfigService 的密钥编排全部分支。
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
const ENV_KEYS = ['MWO_LLM_BASE_URL', 'MWO_LLM_API_KEY', 'MWO_LLM_MODEL'] as const

let workDir: string
let handle: DbHandle
let service: DataService
let keyStore: KeyStoreService
let svc: ModelConfigService
let savedEnv: Record<string, string | undefined>

// 与主进程 makeProviderStore 同构的端口实现：保证单测路由与生产装配
// 走完全一致的 resolveChatProvider 优先级链。
let adapter: {
  request<T extends DbRequestType>(
    type: T,
    payload: DbRequestMap[T]['request']
  ): Promise<DbRequestMap[T]['response']>
}

function makeStore(): ProviderStorePort {
  return {
    getDefaultConfig: async () =>
      (await adapter.request('modelConfig.getDefault', undefined)) ?? null,
    decryptKey: (ref) => keyStore.getKey(ref)
  }
}

function readKeyStoreRaw(): string {
  return readFileSync(join(workDir, 'secure', 'api-keys.json'), 'utf-8')
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-modelconfig-'))
  // 与主进程装配对齐：secure/ 目录由装配方预建（生产为 ensureDir）。
  mkdirSync(join(workDir, 'secure'), { recursive: true })
  handle = openDatabase(join(workDir, 'test.db'))
  service = new DataService({
    handle,
    dirs: { tmpDir: join(workDir, 'tmp'), changesetDir: workDir }
  })
  keyStore = new KeyStoreService({ secureDir: join(workDir, 'secure'), crypto: new FakeCrypto() })
  adapter = {
    async request<T extends DbRequestType>(
      type: T,
      payload: DbRequestMap[T]['request']
    ): Promise<DbRequestMap[T]['response']> {
      switch (type) {
        case 'modelConfig.create':
          return service.modelConfigs.create(payload as ModelConfigRecord) as never
        case 'modelConfig.get':
          return service.modelConfigs.get((payload as { id: string }).id) as never
        case 'modelConfig.list':
          return service.modelConfigs.list() as never
        case 'modelConfig.update': {
          const p = payload as { id: string; patch: Partial<ModelConfigRecord> }
          return service.modelConfigs.update(p.id, p.patch) as never
        }
        case 'modelConfig.delete':
          return service.modelConfigs.delete((payload as { id: string }).id) as never
        case 'modelConfig.getDefault':
          return service.modelConfigs.getDefault() as never
        case 'modelConfig.setDefault':
          return service.modelConfigs.setDefault((payload as { id: string }).id) as never
        default:
          throw new Error(`unexpected db request in test: ${type}`)
      }
    }
  }
  svc = new ModelConfigService({ dbPort: adapter, keyStore })
  // resolveChatProvider 的 env 三元组优先级最高：单测必须屏蔽宿主环境
  // 残留的 MWO_LLM_*（否则 store 路由永远不会被走到）。
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 移除 env 只能用 delete（赋 undefined 不等价于不存在）
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 同上：还原现场需真正移除
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  service.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('ModelConfigService（T-S2-07 配置编排）', () => {
  it('首条配置自动成为默认；视图零明文、DB 行只存引用、密文落盘', async () => {
    const view = await svc.save({
      name: '主力模型',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: PLAIN_KEY
    })

    expect(view.isDefault).toBe(true)
    expect(view.hasKey).toBe(true)
    expect(view.maskedKey).toBe('sk-l****wxyz')

    // 渲染层视图零明文（PRD 7A.2）：序列化全量视图不含明文密钥。
    expect(JSON.stringify(await svc.listViews())).not.toContain(PLAIN_KEY)

    // DB 行只存 key-<uuid> 引用，不含明文。
    const record = service.modelConfigs.get(view.id)
    expect(record?.apiKeyRef).toMatch(/^key-/)
    expect(JSON.stringify(record)).not.toContain(PLAIN_KEY)

    // 密文文件同样不含明文。
    expect(readKeyStoreRaw()).not.toContain(PLAIN_KEY)
  })

  it('密钥三态：省略=保持 / 空串=清除 / 非空=覆写', async () => {
    const created = await svc.save({
      name: 'A',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: PLAIN_KEY
    })
    const refBefore = service.modelConfigs.get(created.id)?.apiKeyRef
    expect(refBefore).toMatch(/^key-/)
    if (!refBefore) throw new Error('apiKeyRef 应在保存后存在')

    // 省略 apiKey：引用与密文保持不变。
    const kept = await svc.save({
      id: created.id,
      name: 'A2',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1'
    })
    expect(kept.hasKey).toBe(true)
    expect(kept.maskedKey).toBe('sk-l****wxyz')
    expect(service.modelConfigs.get(created.id)?.apiKeyRef).toBe(refBefore)

    // 非空覆写：复用同一引用，密文原地替换。
    await svc.save({
      id: created.id,
      name: 'A2',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: 'sk-live-rotated-key-9876543210'
    })
    expect(service.modelConfigs.get(created.id)?.apiKeyRef).toBe(refBefore)
    expect(keyStore.getKey(refBefore)).toBe('sk-live-rotated-key-9876543210')

    // 空串清除：删密文条目 + 置空引用。
    const cleared = await svc.save({
      id: created.id,
      name: 'A2',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: ''
    })
    expect(cleared.hasKey).toBe(false)
    expect(cleared.maskedKey).toBeNull()
    expect(service.modelConfigs.get(created.id)?.apiKeyRef).toBeNull()
    expect(keyStore.hasKey(refBefore)).toBe(false)
  })

  it('remove：先删密文条目再删 DB 行（§5 清理顺序）', async () => {
    const created = await svc.save({
      name: 'A',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: PLAIN_KEY
    })
    const ref = service.modelConfigs.get(created.id)?.apiKeyRef
    if (!ref) throw new Error('apiKeyRef 应在保存后存在')

    await svc.remove(created.id)

    expect(service.modelConfigs.get(created.id)).toBeNull()
    expect(keyStore.hasKey(ref)).toBe(false)
    await expect(svc.remove(created.id)).rejects.toThrowError(/MODEL_CONFIG_NOT_FOUND/)
  })

  it('setDefault：事务内先清全部默认再置目标（无双默认）', async () => {
    const first = await svc.save({
      name: 'A',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1'
    })
    const second = await svc.save({
      name: 'B',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v2',
      model: 'm2'
    })
    expect(first.isDefault).toBe(true)
    expect(second.isDefault).toBe(false)

    const defaulted = await svc.setDefault(second.id)

    expect(defaulted.isDefault).toBe(true)
    expect(service.modelConfigs.get(first.id)?.isDefault).toBe(false)
    expect(service.modelConfigs.getDefault()?.id).toBe(second.id)
  })

  it('校验：空名/空模型/协议不支持 → MODEL_CONFIG_INVALID', async () => {
    await expect(
      svc.save({ name: '  ', protocol: 'openai-compatible', model: 'm1' })
    ).rejects.toThrowError(/MODEL_CONFIG_INVALID/)
    await expect(
      svc.save({ name: 'A', protocol: 'openai-compatible', model: ' ' })
    ).rejects.toThrowError(/MODEL_CONFIG_INVALID/)
    await expect(
      svc.save({ name: 'A', protocol: 'anthropic', model: 'm1' })
    ).rejects.toThrowError(/MODEL_CONFIG_INVALID/)
  })

  it('校验：更新/删除/设默认不存在的 id → MODEL_CONFIG_NOT_FOUND', async () => {
    await expect(
      svc.save({ id: 'mc-nope', name: 'A', protocol: 'openai-compatible', model: 'm1' })
    ).rejects.toThrowError(/MODEL_CONFIG_NOT_FOUND/)
    await expect(svc.remove('mc-nope')).rejects.toThrowError(/MODEL_CONFIG_NOT_FOUND/)
    await expect(svc.setDefault('mc-nope')).rejects.toThrowError(/MODEL_CONFIG_NOT_FOUND/)
  })

  it('safeStorage 不可用时携带 apiKey 保存 → KEYSTORE_UNAVAILABLE（宁可不保存）', async () => {
    const dead = new ModelConfigService({
      dbPort: adapter,
      keyStore: new KeyStoreService({
        secureDir: join(workDir, 'secure'),
        crypto: new UnavailableCrypto()
      })
    })
    await expect(
      dead.save({
        name: 'A',
        protocol: 'openai-compatible',
        model: 'm1',
        apiKey: PLAIN_KEY
      })
    ).rejects.toThrowError(/KEYSTORE_UNAVAILABLE/)
    expect(service.modelConfigs.list()).toHaveLength(0)
  })
})

describe('resolveChatProvider（T-S2-07 优先级链 store 路由）', () => {
  it('DB 默认配置 + 主进程解密成功 → openai-compatible', async () => {
    await svc.save({
      name: '主力',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: PLAIN_KEY
    })

    const resolved = await resolveChatProvider(makeStore())

    expect(resolved.mode).toBe('openai-compatible')
    expect(resolved.note).toBeUndefined()
  })

  it('密钥解密失败（keychain 重置形态）→ 诚实降级 mock 并说明原因', async () => {
    await svc.save({
      name: '主力',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: PLAIN_KEY
    })

    // 与生产 makeProviderStore 同构，但 keyStore 换 key：模拟 OS keychain
    // 重置后旧密文不可解的真实故障形态（AES-GCM auth tag 校验失败 →
    // KeyStoreService catch → null → provider-factory 诚实降级）。
    const rotatedKeyStore = new KeyStoreService({
      secureDir: join(workDir, 'secure'),
      crypto: new FakeCrypto(Buffer.alloc(32, 9))
    })
    const rotatedStore: ProviderStorePort = {
      getDefaultConfig: async () =>
        (await adapter.request('modelConfig.getDefault', undefined)) ?? null,
      decryptKey: (ref) => rotatedKeyStore.getKey(ref)
    }

    const resolved = await resolveChatProvider(rotatedStore)

    expect(resolved.mode).toBe('mock')
    expect(resolved.note).toContain('不完整')
  })

  it('无任何配置 → 降级 mock 并列出缺失项', async () => {
    const resolved = await resolveChatProvider(makeStore())

    expect(resolved.mode).toBe('mock')
    expect(resolved.note).toContain('MWO_LLM_BASE_URL')
  })
})
