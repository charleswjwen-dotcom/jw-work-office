import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AtomicChange } from '@shared/agent'
import type { FileRecord } from '@shared/db-protocol'
import type { VersionView } from '@shared/ipc'
import { Button } from '@renderer/components/ui/button'
import { diffWords, type DiffSegment } from '@renderer/lib/inline-diff'

// 版本历史面板（T-S2-06 回溯 UI，PRD 3.3「线性回溯」/ 架构 §5）。
// 会话列内的版本时间线：点击版本行展开「当前内容 → 快照内容」的段落级
// diff 预览，并提供恢复入口。红=即将移除的当前内容，绿=即将恢复的快照
// 内容，渲染语义与 ChangeSetCard 一致（勿删此口径说明）。
// 分层：恢复 mutation 在 App 层执行——回溯成功会生成反向 ChangeSet 与
// 回溯后快照，气泡提示与缓存失效由 App 层统一收口，本组件只管展示。

// 与 ChangeSetCard 同一展示口径：Record 穷尽 AtomicChange['kind']，
// 后续新增 kind 时两处都会被 typecheck 强制同步。
const KIND_LABEL: Record<AtomicChange['kind'], string> = {
  text: '替换',
  style: '样式',
  insert: '插入',
  delete: '删除',
  cell: '单元格',
  element: '元素',
  image: '图片'
}

const AUTHOR_LABEL: Record<NonNullable<VersionView['author']>, string> = {
  ai: 'AI',
  user: '用户',
  external: '外部'
}

// 与 App.tsx formatTime 同一时间格式，保持会话两栏信息密度一致。
function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

// 与 ChangeSetCard.segmentsFor 同一拆段口径：text 走词级 LCS，
// insert/delete 仅单侧文本时整体高亮。
function segmentsFor(change: AtomicChange): DiffSegment[] {
  const before = typeof change.before?.text === 'string' ? change.before.text : null
  const after = typeof change.after?.text === 'string' ? change.after.text : null
  if (before !== null && after !== null) return diffWords(before, after)
  if (after !== null) return after ? [{ type: 'add', text: after }] : []
  if (before !== null) return before ? [{ type: 'del', text: before }] : []
  return []
}

// 展开区：懒加载恢复 diff（当前 → 快照）+ 恢复按钮。当前版本主进程会以
// ALREADY_CURRENT 拒绝恢复，UI 提前收口不提供入口。
function DiffPreview({
  versionId,
  isCurrent,
  busy,
  onRestore
}: {
  versionId: string
  isCurrent: boolean
  busy?: boolean
  onRestore: (versionId: string) => void
}): React.JSX.Element {
  const diffQuery = useQuery({
    queryKey: ['version-diff', versionId],
    queryFn: () => window.api.getVersionDiff(versionId)
  })

  if (diffQuery.isPending)
    return (
      <p className="border-t border-border-sub px-3.5 py-2 text-xs text-text-muted">正在生成 diff…</p>
    )
  if (diffQuery.isError)
    return (
      <p className="border-t border-border-sub px-3.5 py-2 text-xs text-red">
        diff 加载失败：{diffQuery.error.message}
      </p>
    )

  const res = diffQuery.data
  if (!res.ok)
    return (
      <p className="border-t border-border-sub px-3.5 py-2 text-xs text-red">
        无法生成 diff [{res.error?.code ?? 'UNKNOWN'}]：{res.error?.message ?? '未知错误'}
      </p>
    )

  const changes = res.changes ?? []
  return (
    <div className="border-t border-border-sub bg-base">
      {changes.length === 0 ? (
        <p className="px-3.5 py-2 text-xs text-text-muted">与当前内容一致，无需恢复。</p>
      ) : (
        <div className="divide-y divide-border-sub">
          {changes.map((change) => (
            <div key={change.id} className="px-3.5 py-1.5">
              <div className="min-w-0 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">
                <span className="mr-1.5 font-mono text-[10px] text-text-muted">
                  {KIND_LABEL[change.kind]} ·{' '}
                  {change.location.type === 'paragraph'
                    ? `¶${change.location.index}`
                    : change.location.type}
                </span>
                {segmentsFor(change).map((seg, j) => {
                  if (seg.type === 'equal') return <span key={j}>{seg.text}</span>
                  if (seg.type === 'del')
                    return (
                      <span key={j} className="rounded-sm bg-red-soft px-1 text-red line-through">
                        {seg.text}
                      </span>
                    )
                  return (
                    <span key={j} className="rounded-sm bg-green-soft px-1 text-green">
                      {seg.text}
                    </span>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {!isCurrent && (
        <div className="flex items-center gap-2 border-t border-border-sub px-3.5 py-2.5">
          <span className="mr-auto text-[11px] text-text-muted">
            {changes.length > 0 ? `${changes.length} 处差异 · 红=移除当前，绿=恢复快照` : '内容一致'}
          </span>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onRestore(versionId)}>
            {busy ? '恢复中…' : '恢复到此版本'}
          </Button>
        </div>
      )}
    </div>
  )
}

export interface VersionHistoryPanelProps {
  file: FileRecord
  busy?: boolean
  onRestore: (versionId: string) => void
}

export function VersionHistoryPanel({
  file,
  busy,
  onRestore
}: VersionHistoryPanelProps): React.JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const versionsQuery = useQuery({
    queryKey: ['versions', file.id],
    queryFn: () => window.api.listVersions(file.id)
  })
  const versions = versionsQuery.data ?? []

  const toggle = (id: string): void => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">版本历史</h3>
        {versionsQuery.isFetching && <span className="text-[10px] text-text-faint">刷新中…</span>}
        {versionsQuery.isError && (
          <span className="text-[10px] text-red">加载失败：{versionsQuery.error.message}</span>
        )}
      </div>
      {versions.length === 0 ? (
        <p className="rounded-sm border border-dashed border-border-sub px-3 py-2 text-xs text-text-muted">
          {versionsQuery.isPending
            ? '正在加载版本…'
            : '暂无版本快照。接受一次 AI 变更或执行一次恢复后，会自动生成版本记录。'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-sm border border-border bg-surface-raised shadow-sm">
          <div className="divide-y divide-border-sub">
            {versions.map((v) => (
              <div key={v.id}>
                <button
                  onClick={() => toggle(v.id)}
                  aria-expanded={expandedId === v.id}
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left hover:bg-surface-hover"
                >
                  <span className="shrink-0 rounded-sm border border-border px-1.5 py-px font-mono text-[10px] text-text-muted">
                    v{v.seq}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-text-body"
                    title={v.triggerCommand ?? undefined}
                  >
                    {v.changeSummary ?? v.triggerCommand ?? '（无摘要）'}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-text-faint">
                    {v.author ? AUTHOR_LABEL[v.author] : '—'} · {formatTime(v.createdAt)}
                  </span>
                  {v.isCurrent && (
                    <span className="shrink-0 rounded-full bg-green-soft px-2 py-0.5 text-[11px] text-green">
                      当前
                    </span>
                  )}
                </button>
                {expandedId === v.id && (
                  <DiffPreview
                    versionId={v.id}
                    isCurrent={v.isCurrent}
                    busy={busy}
                    onRestore={onRestore}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
