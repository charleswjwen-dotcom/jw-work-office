import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FileRecord } from '@shared/db-protocol'
import { Button } from '@renderer/components/ui/button'

// 手动微调面板（T-S2-05A 第 1 层，PRD 2A.6 / 架构 §5.1「单一事实源」）。
// 右栏按段落直接编辑文本，提交「全量段落」给主进程 createManualPending：
// 服务端与磁盘基线逐段 diff，仅差异段落产出 source=manual 的标准 pending
// ChangeSet，确认/部分应用/快照/回溯与 AI 变更完全同链路，渲染层不自行
// 拼装变更（勿删此口径说明）。
// 提交前校验对齐 trust-service：段落文本非空且不含换行
// （word.applyParagraphEdits 不支持段落增删，空段/换行会导致落盘索引错位）。
// 分层：提交 mutation 在 App 层执行（气泡提示与缓存失效统一收口），
// 本组件只管草稿态；App 以 key={`${fileId}:${manualResetSeq}`} 重挂载，
// 提交成功或切换文件即清空草稿。

export interface ManualEditPanelProps {
  file: FileRecord
  busy?: boolean
  onSubmit: (editedParagraphs: { index: number; text: string }[]) => void
}

export function ManualEditPanel({ file, busy, onSubmit }: ManualEditPanelProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const paragraphsQuery = useQuery({
    queryKey: ['paragraphs', file.id],
    queryFn: () => window.api.getParagraphs(file.id)
  })
  const res = paragraphsQuery.data
  // 结构共享下内容不变则引用稳定：引用变化=段落基线真的变了。
  const paragraphs = res?.ok && res.paragraphs !== undefined ? res.paragraphs : null

  // 段落基线变化（AI 应用/回溯/外部采纳·忽略都会失效 ['paragraphs']）时，
  // 既有草稿的段落索引已错位——清空草稿并提示，防止编辑落到错误段落上。
  const prevParagraphsRef = useRef<string[] | null>(null)
  useEffect(() => {
    if (paragraphs === null) return
    const changed = prevParagraphsRef.current !== null && prevParagraphsRef.current !== paragraphs
    prevParagraphsRef.current = paragraphs
    if (changed && Object.keys(drafts).length > 0) {
      setDrafts({})
      setNotice('文件内容已更新，草稿已清空（段落索引变化，防止错位编辑）。')
    }
  }, [paragraphs, drafts])

  if (paragraphsQuery.isPending)
    return <p className="text-sm text-text-muted">正在加载段落…</p>
  if (paragraphsQuery.isError)
    return <p className="text-sm text-red">段落加载失败：{paragraphsQuery.error.message}</p>
  if (!res?.ok)
    return (
      <p className="text-sm text-red">
        无法读取段落 [{res?.error?.code ?? 'UNKNOWN'}]：{res?.error?.message ?? '未知错误'}
      </p>
    )
  if (paragraphs === null || paragraphs.length === 0)
    return <p className="text-sm text-text-muted">该文档没有可编辑的段落。</p>

  const dirtyCount = paragraphs.reduce(
    (n, text, i) => (drafts[i] !== undefined && drafts[i] !== text ? n + 1 : n),
    0
  )

  const setDraft = (index: number, text: string): void => {
    setError(null)
    setNotice(null)
    setDrafts((prev) => ({ ...prev, [index]: text }))
  }

  // 段落内禁止换行（与服务端 MANUAL_PARAGRAPH_INVALID 同口径）；
  // isComposing 让路输入法选词阶段（与 App 输入框同一处理）。
  const onParagraphKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault()
  }

  const clearDrafts = (): void => {
    setDrafts({})
    setError(null)
    setNotice(null)
  }

  const submit = (): void => {
    if (busy) return
    // 粘贴可能带入换行：提交前统一折叠为空格（服务端拒绝含 \n 的段落）。
    const edited = paragraphs.map((text, i) => (drafts[i] ?? text).replace(/[\r\n]+/g, ' '))
    if (edited.some((text) => text.length === 0)) {
      setError('段落不能为空（段落增删请走对话流程）。')
      return
    }
    if (dirtyCount === 0) return
    onSubmit(edited.map((text, index) => ({ index, text })))
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">手动微调</h3>
        {paragraphsQuery.isFetching && (
          <span className="text-[10px] text-text-faint">刷新中…</span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-text-faint">共 {paragraphs.length} 段</span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
        直接编辑段落文本，提交后生成「手动微调」变更集，按与 AI 变更相同的信任流程确认应用。段落内不支持换行；段落增删请走对话。
      </p>
      {notice && (
        <p className="mb-2 rounded-sm border border-amber/40 bg-amber-soft px-2.5 py-1.5 text-xs text-amber">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-2 rounded-sm border border-red/40 bg-red-soft px-2.5 py-1.5 text-xs text-red">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {paragraphs.map((text, i) => {
          const value = drafts[i] ?? text
          const dirty = drafts[i] !== undefined && drafts[i] !== text
          return (
            <div key={i} className="flex items-start gap-1.5">
              <span className="mt-2 w-7 shrink-0 text-right font-mono text-[10px] text-text-faint">
                ¶{i}
              </span>
              <textarea
                value={value}
                onChange={(e) => setDraft(i, e.target.value)}
                onKeyDown={onParagraphKeyDown}
                disabled={busy}
                rows={Math.min(12, Math.max(2, Math.ceil(value.length / 22)))}
                className={`min-w-0 flex-1 resize-none rounded-sm border px-2.5 py-1.5 text-xs leading-relaxed outline-none placeholder:text-text-faint disabled:opacity-60 ${
                  dirty ? 'border-accent bg-accent-soft text-accent-text' : 'border-border bg-surface'
                }`}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="mr-auto text-[11px] text-text-muted">
          {dirtyCount > 0 ? `已修改 ${dirtyCount} 段` : '未修改'}
        </span>
        <Button variant="ghost" size="sm" disabled={busy || dirtyCount === 0} onClick={clearDrafts}>
          清空草稿
        </Button>
        <Button variant="primary" size="sm" disabled={busy || dirtyCount === 0} onClick={submit}>
          {busy ? '提交中…' : '提交变更'}
        </Button>
      </div>
    </div>
  )
}
