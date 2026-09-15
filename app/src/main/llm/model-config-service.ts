import { randomUUID } from 'node:crypto'
import type { DbRequestMap, DbRequestType, ModelConfigRecord } from '../../shared/db-protocol'
import type { ModelConfigView, SaveModelConfigInput } from '../../shared/ipc'
import type { KeyStoreService } from '../security/key-store'

// M1 冻结（HLD §3.5）：唯一受支持协议是 OpenAI 兼容端点。
// 预留数组结构，S3 扩展 Anthropic 等协议时在此追加。
const SUPPORTED_PROTOCOLS = ['openai-compatible']

// 与 DbClient 同构的请求端口（trust-service 同款注入式设计）：
// 测试用进程内 DataService 适配器（switch + as never）即可覆盖全部分支，
// 无需 fork utilityProcess。
export interface ModelConfigDbPort {
  request<T extends DbRequestType>(
    type: T,
    payload: DbRequestMap[T]['request']
  ): Promise<DbRequestMap[T]['response']>
}

export interface ModelConfigServiceOptions {
  dbPort: ModelConfigDbPort
  keyStore: KeyStoreService
}

// —— T-S2-07 多模型配置编排（架构 §3.5/§3.6，PRD 7A.2）——
// 职责：配置 CRUD 编排 + 密钥引用与 KeyStore 的一致性 + 渲染层零明文视图。
// 错误约定与信任流一致：Error('CODE: message')，由 IPC 层 toTrustError 降级为
// { ok:false, error:{ code, message } }（MODEL_CONFIG_INVALID / MODEL_CONFIG_NOT_FOUND
// / KEYSTORE_UNAVAILABLE）。
export class ModelConfigService {
  private readonly dbPort: ModelConfigDbPort
  private readonly keyStore: KeyStoreService

  constructor({ dbPort, keyStore }: ModelConfigServiceOptions) {
    this.dbPort = dbPort
    this.keyStore = keyStore
  }

  async listViews(): Promise<ModelConfigView[]> {
    const records = await this.dbPort.request('modelConfig.list', undefined)
    return records.map((record) => this.toView(record))
  }

  // 保存（create 或 update 由 input.id 决定）。
  // 密钥三态：省略 = 保持现有密钥；空串 = 清除；非空 = 覆写。
  async save(input: SaveModelConfigInput): Promise<ModelConfigView> {
    const name = input.name?.trim()
    const model = input.model?.trim()
    if (!name || !model) {
      throw new Error('MODEL_CONFIG_INVALID: 名称与模型不能为空')
    }
    if (!SUPPORTED_PROTOCOLS.includes(input.protocol)) {
      throw new Error(
        `MODEL_CONFIG_INVALID: 协议 ${input.protocol} 暂不支持（当前仅 openai-compatible）`
      )
    }
    // 密钥前置检查（PRD 7A.2 隐私红线）：safeStorage 不可用时结构化报错，
    // 宁可不保存，绝不静默明文落盘。
    if (input.apiKey !== undefined && input.apiKey !== '' && !this.keyStore.available()) {
      throw new Error('KEYSTORE_UNAVAILABLE: 系统加密存储不可用，无法保存 API Key')
    }
    if (input.id) {
      return this.update(input, input.id, name, model)
    }
    return this.create(input, name, model)
  }

  async remove(id: string): Promise<void> {
    const existing = await this.dbPort.request('modelConfig.get', { id })
    if (!existing) {
      throw new Error(`MODEL_CONFIG_NOT_FOUND: 模型配置 ${id} 不存在`)
    }
    // 架构 §5 清理顺序（同 discardChangeSet）：先删密文文件条目，再删 DB 行——
    // 中断只留下无害残留（孤立密文条目），不留明文、不留悬空引用的可用密钥。
    if (existing.apiKeyRef) {
      this.keyStore.deleteKey(existing.apiKeyRef)
    }
    await this.dbPort.request('modelConfig.delete', { id })
  }

  async setDefault(id: string): Promise<ModelConfigView> {
    const existing = await this.dbPort.request('modelConfig.get', { id })
    if (!existing) {
      throw new Error(`MODEL_CONFIG_NOT_FOUND: 模型配置 ${id} 不存在`)
    }
    const updated = await this.dbPort.request('modelConfig.setDefault', { id })
    return this.toView(updated ?? existing)
  }

  private async create(
    input: SaveModelConfigInput,
    name: string,
    model: string
  ): Promise<ModelConfigView> {
    const existingList = await this.dbPort.request('modelConfig.list', undefined)
    // 首条配置自动成为默认：用户录入第一个模型即可用，无需再手动设默认。
    const isDefault = input.isDefault ?? existingList.length === 0
    let apiKeyRef: string | null = null
    if (input.apiKey) {
      apiKeyRef = this.keyStore.generateRef()
      this.keyStore.setKey(apiKeyRef, input.apiKey)
    }
    const record: ModelConfigRecord = {
      id: `mc-${randomUUID()}`,
      name,
      protocol: input.protocol,
      baseUrl: input.baseUrl?.trim() || null,
      model,
      apiKeyRef,
      isDefault
    }
    const created = await this.dbPort.request('modelConfig.create', record)
    // 建行后走事务版 setDefault 归一（清其他行的默认位），避免双默认。
    if (isDefault) {
      const defaulted = await this.dbPort.request('modelConfig.setDefault', {
        id: created.id
      })
      return this.toView(defaulted ?? created)
    }
    return this.toView(created)
  }

  // id 由 save 的 `if (input.id)` 分支保证非空，显式参数传递以保住 narrowing。
  private async update(
    input: SaveModelConfigInput,
    id: string,
    name: string,
    model: string
  ): Promise<ModelConfigView> {
    const existing = await this.dbPort.request('modelConfig.get', { id })
    if (!existing) {
      throw new Error(`MODEL_CONFIG_NOT_FOUND: 模型配置 ${id} 不存在`)
    }
    let apiKeyRef = existing.apiKeyRef
    if (input.apiKey !== undefined) {
      if (input.apiKey === '') {
        // 清除：删密文条目 + 置空引用。
        if (apiKeyRef) this.keyStore.deleteKey(apiKeyRef)
        apiKeyRef = null
      } else {
        // 覆写：复用既有引用（密文原地替换），无引用时新生成。
        const ref = apiKeyRef ?? this.keyStore.generateRef()
        this.keyStore.setKey(ref, input.apiKey)
        apiKeyRef = ref
      }
    }
    const updated = await this.dbPort.request('modelConfig.update', {
      id,
      patch: {
        name,
        protocol: input.protocol,
        baseUrl: input.baseUrl?.trim() || null,
        model,
        apiKeyRef
      }
    })
    if (!updated) {
      throw new Error(`MODEL_CONFIG_NOT_FOUND: 模型配置 ${id} 不存在`)
    }
    if (input.isDefault) {
      const defaulted = await this.dbPort.request('modelConfig.setDefault', {
        id: updated.id
      })
      return this.toView(defaulted ?? updated)
    }
    return this.toView(updated)
  }

  // 视图窄化（架构 §2 安全红线）：渲染层只拿 hasKey/maskedKey，
  // 明文密钥不出主进程；掩码由 KeyStore 生成（首尾 4 字符展示）。
  private toView(record: ModelConfigRecord): ModelConfigView {
    return {
      id: record.id,
      name: record.name,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      model: record.model,
      hasKey: record.apiKeyRef !== null && this.keyStore.hasKey(record.apiKeyRef),
      maskedKey: record.apiKeyRef ? this.keyStore.maskForRef(record.apiKeyRef) : null,
      isDefault: record.isDefault
    }
  }
}
