import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ModelConfigView, SaveModelConfigInput } from '@shared/ipc'
import { Button } from '@renderer/components/ui/button'

// 模型设置面板（T-S2-07，PRD 7A.2 / 架构 §3.6）。
// 隐私红线在 UI 侧的体现：渲染层只持有 hasKey/maskedKey 掩码字段，
// 不存在明文密钥的展示/回填/传输路径——编辑时密钥框留空 = 保持已存密钥
// （SaveModelConfigInput.apiKey 三态：省略=保持 / 空串=清除 / 非空=覆写）。
// 与信任流组件不同源：设置操作不产生会话气泡，mutation 在本组件内闭环，
// 仅失效 model-configs / provider-status 两个自身缓存域。

interface ConfigForm {
  id?: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
  isDefault: boolean
}

const EMPTY_FORM: ConfigForm = {
  id: undefined,
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  isDefault: false
}

const inputCls =
  'w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs outline-none placeholder:text-text-faint'

const errText = (code?: string, message?: string): string =>
  `[${code ?? 'UNKNOWN'}] ${message ?? '未知错误'}`

export interface ModelConfigPanelProps {
  open: boolean
  onClose: () => void
}

export function ModelConfigPanel({
  open,
  onClose
}: ModelConfigPanelProps): React.JSX.Element | null {
  const qc = useQueryClient()
  // null = 列表态；非 null = 新建/编辑表单态。
  const [form, setForm] = useState<ConfigForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const configsQuery = useQuery({
    queryKey: ['model-configs'],
    queryFn: () => window.api.listModelConfigs(),
    enabled: open
  })
  const statusQuery = useQuery({
    queryKey: ['provider-status'],
    queryFn: () => window.api.getProviderStatus(),
    enabled: open
  })

  // Esc 关闭：modal 顶层无焦点时仍可响应。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['model-configs'] })
    void qc.invalidateQueries({ queryKey: ['provider-status'] })
  }

  const saveMutation = useMutation({
    mutationFn: (input: SaveModelConfigInput) => window.api.saveModelConfig(input),
    onSuccess: (res) => {
      if (!res.ok) {
        setFormError(errText(res.error?.code, res.error?.message))
        return
      }
      setForm(null)
      setFormError(null)
      refresh()
    },
    onError: (err: Error) => setFormError(`通信失败：${err.message}`)
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.api.deleteModelConfig(id),
    onSuccess: (res) => {
      if (!res.ok) {
        setListError(errText(res.error?.code, res.error?.message))
        return
      }
      setListError(null)
      refresh()
    },
    onError: (err: Error) => setListError(`通信失败：${err.message}`)
  })

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => window.api.setDefaultModelConfig(id),
    onSuccess: (res) => {
      if (!res.ok) {
        setListError(errText(res.error?.code, res.error?.message))
        return
      }
      setListError(null)
      refresh()
    },
    onError: (err: Error) => setListError(`通信失败：${err.message}`)
  })

  // 清除密钥 = apiKey 三态的「空串」分支：只动密钥，其余字段原样回传。
  const clearKeyMutation = useMutation({
    mutationFn: (c: ModelConfigView) =>
      window.api.saveModelConfig({
        id: c.id,
        name: c.name,
        protocol: c.protocol,
        baseUrl: c.baseUrl,
        model: c.model,
        apiKey: '',
        isDefault: c.isDefault
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        setFormError(errText(res.error?.code, res.error?.message))
        return
      }
      setFormError(null)
      refresh()
    },
    onError: (err: Error) => setFormError(`通信失败：${err.message}`)
  })

  const startEdit = (c: ModelConfigView): void => {
    setForm({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl ?? '',
      model: c.model,
      apiKey: '',
      isDefault: c.isDefault
    })
    setFormError(null)
  }

  const onDelete = (c: ModelConfigView): void => {
    if (!window.confirm(`确定删除配置「${c.name}」？对应密钥将一并清除，此操作不可撤销。`)) {
      return
    }
    setListError(null)
    deleteMutation.mutate(c.id)
  }

  const submitForm = (): void => {
    if (!form) return
    const input: SaveModelConfigInput = {
      id: form.id,
      name: form.name,
      protocol: 'openai-compatible',
      baseUrl: form.baseUrl.trim() || null,
      model: form.model,
      isDefault: form.isDefault
    }
    if (form.apiKey.trim() !== '') input.apiKey = form.apiKey.trim()
    saveMutation.mutate(input)
  }

  if (!open) return null

  const status = statusQuery.data
  const configs = configsQuery.data ?? []
  const busy =
    saveMutation.isPending || deleteMutation.isPending || setDefaultMutation.isPending
  // 编辑态中「清除已存密钥」入口的目标行（仅已配密钥时显示）。
  const editingView = form?.id ? configs.find((c) => c.id === form.id) : undefined

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="模型设置"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-head">模型设置</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* Provider 状态徽章：mock 降级必须明示原因（诚实降级口径）。 */}
          <div className="mb-3 space-y-2">
            {status ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    status.mode === 'openai-compatible'
                      ? 'bg-green-soft text-green'
                      : 'bg-amber-soft text-amber'
                  }`}
                >
                  {status.mode === 'openai-compatible' ? '已连接真实模型' : 'Mock 模式'}
                </span>
                {status.mode === 'mock' && status.note && (
                  <span className="text-[11px] text-text-muted">{status.note}</span>
                )}
              </div>
            ) : (
              <span className="text-[11px] text-text-faint">正在读取 Provider 状态…</span>
            )}
            {status && !status.encryptionAvailable && (
              <p className="rounded-sm border border-red/40 bg-red-soft px-3 py-2 text-xs text-red">
                系统加密存储（safeStorage）当前不可用：无法保存新的 API Key，已保存的密钥也可能无法解密。其余字段仍可正常编辑。
              </p>
            )}
          </div>

          {listError && (
            <p className="mb-3 rounded-sm border border-red/40 bg-red-soft px-3 py-2 text-xs text-red">
              {listError}
            </p>
          )}

          {form ? (
            <div>
              <h3 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-text-muted">
                {form.id ? '编辑配置' : '新建配置'} · OpenAI 兼容协议
              </h3>
              <div className="space-y-2.5">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-text-muted">名称</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputCls}
                    placeholder="如「我的 DeepSeek」"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-text-muted">
                    Base URL（OpenAI 兼容端点）
                  </span>
                  <input
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    className={inputCls}
                    placeholder="https://api.deepseek.com/v1"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-text-muted">模型 ID</span>
                  <input
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className={inputCls}
                    placeholder="如 deepseek-chat"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-text-muted">
                    API Key（本地加密存储，不上传、不写日志）
                    {editingView?.maskedKey ? ` · 已存 ${editingView.maskedKey}，留空保持不变` : ''}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    className={inputCls}
                    placeholder={form.id ? '留空保持已存密钥不变' : 'sk-…'}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-text-body">
                  <input
                    type="checkbox"
                    checked={form.isDefault}
                    onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  设为默认模型
                </label>
                {formError && <p className="text-xs text-red">{formError}</p>}
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={saveMutation.isPending}
                    onClick={submitForm}
                  >
                    {saveMutation.isPending ? '保存中…' : '保存'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saveMutation.isPending}
                    onClick={() => {
                      setForm(null)
                      setFormError(null)
                    }}
                  >
                    取消
                  </Button>
                  {editingView?.hasKey && (
                    <Button
                      variant="danger"
                      size="sm"
                      className="ml-auto"
                      disabled={clearKeyMutation.isPending}
                      onClick={() => clearKeyMutation.mutate(editingView)}
                    >
                      {clearKeyMutation.isPending ? '清除中…' : '清除已存密钥'}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  模型配置
                </h3>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    // 首条配置自动默认（与主进程 create 分支同规则）。
                    setForm({ ...EMPTY_FORM, isDefault: configs.length === 0 })
                    setFormError(null)
                  }}
                >
                  新建配置
                </Button>
              </div>
              {configsQuery.isPending ? (
                <p className="text-xs text-text-muted">正在加载配置…</p>
              ) : configsQuery.isError ? (
                <p className="text-xs text-red">加载失败：{configsQuery.error.message}</p>
              ) : configs.length === 0 ? (
                <p className="rounded-sm border border-dashed border-border-sub px-3 py-2 text-xs text-text-muted">
                  暂无模型配置。新建一条并保存后（首条自动设为默认），对话将使用该模型；未配置时诚实降级为 Mock 链路验证模式。
                </p>
              ) : (
                <div className="overflow-hidden rounded-sm border border-border bg-surface">
                  <div className="divide-y divide-border-sub">
                    {configs.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 px-3.5 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-text-body">
                              {c.name}
                            </span>
                            {c.isDefault && (
                              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent-text">
                                默认
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                            {c.model}
                            {c.baseUrl ? ` · ${c.baseUrl}` : ''}
                            {c.hasKey ? ` · 密钥 ${c.maskedKey}` : ' · 无密钥'}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => startEdit(c)}
                        >
                          编辑
                        </Button>
                        {!c.isDefault && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setDefaultMutation.mutate(c.id)}
                          >
                            设为默认
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busy}
                          onClick={() => onDelete(c)}
                        >
                          删除
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
