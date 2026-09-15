import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AtomicChange } from '@shared/agent'
import { Button } from '@renderer/components/ui/button'
import { diffWords, type DiffSegment } from '@renderer/lib/inline-diff'

// 外部编辑感知面板（T-S2-05A 第 2 层，PRD 2A.6「不静默覆盖」）。
// 检出横幅置于会话顶部：磁盘内容已偏离基线时给出三选项——
// 采纳为新基线（ChangeSet source=external + Version author=external）、
// 忽略（仅基线前移，不落版本记录）、查看 diff；被检出置 stale 的待确认
// 变更集不在 pending 列表展示，由 stalePendingCount 在此显式提示。
// 分层：采纳/忽略/扫描 mutation 在 App 层执行（气泡提示与缓存失效统一
// 收口），本组件只管展示与轮询（勿删此分层说明）。
// 5s 轮询 + 主进程 fs.watch 去抖：渲染层无需自建文件监听。

// 与 ChangeSetCard / VersionHistoryPanel 同一展示口径：Record 穷尽
// AtomicChange['kind']，新增 kind 时三处都会被 typecheck 强制同步。
const KIND_LABEL: Record<AtomicChange['kind'], string> = {
  text: '替换',
  style: '样式',
  insert: '插入',
  delete: '删除',
  cell: '单元格',
  element: '元素',
  image: '图片'
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

// 与 App.tsx formatTime 同一时间格式，保持会话两栏信息密度一致。
function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

// 展开区：外部改动 vs 当前基线的段落级 diff，红=基线即将被替换的现有内容，
// 绿=磁盘新内容（采纳后得到），渲染语义与 VersionDiff 相反方向。
function DiffPreview({
  fileId,
  busy,
  onAccept
}: {
  fileId: string
  busy?: boolean
  onAccept: (fileId: string) => void
}): React.JSX.Element {
  const diffQuery = useQuery({
    queryKey: ['external-diff', fileId],
    queryFn: () => window.api.getExternalDiff(fileId)
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
        <p className="px-3.5 py-2 text-xs text-text-muted">
          外部改动与当前基线一致（可能已被处理，可刷新确认）。
        </p>
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
      <div className="flex items-center gap-2 border-t border-border-sub px-3.5 py-2.5">
        <span className="mr-auto text-[11px] text-text-muted">
          {changes.length > 0
            ? `${changes.length} 处差异 · 红=基线现有内容，绿=磁盘新内容`
            : '内容一致'}
        </span>
        {changes.length > 0 && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onAccept(fileId)}>
            采纳为新基线
          </Button>
        )}
      </div>
    </div>
  )
}

export interface ExternalChangePanelProps {
  busy?: boolean
  scanning?: boolean
  onAccept: (fileId: string) => void
  onIgnore: (fileId: string) => void
  onScan: () => void
}

export function ExternalChangePanel({
  busy,
  scanning,
  onAccept,
  onIgnore,
  onScan
}: ExternalChangePanelProps): React.JSX.Element | null {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const detectionsQuery = useQuery({
    queryKey: ['external-detections'],
    queryFn: () => window.api.listExternalDetections(),
    refetchInterval: 5_000
  })
  const detections = detectionsQuery.data ?? []
  if (detections.length === 0) return null

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-amber">外部编辑</h3>
        <span className="font-mono text-[10px] text-text-faint">{detections.length} 个文件</span>
        {detectionsQuery.isError && (
          <span className="text-[10px] text-red">轮询失败：{detectionsQuery.error.message}</span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={scanning} onClick={onScan}>
          {scanning ? '扫描中…' : '立即扫描'}
        </Button>
      </div>
      <div className="space-y-2">
        {detections.map((d) => (
          <div
            key={d.fileId}
            className="overflow-hidden rounded-sm border border-amber/40 bg-surface-raised shadow-sm"
          >
            <div className="flex items-center gap-2.5 border-b border-border-sub px-3.5 py-2.5">
              <span className="min-w-0 truncate text-[12.5px] font-semibold text-text-head">
                {d.fileName}
              </span>
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setExpandedId((prev) => (prev === d.fileId ? null : d.fileId))}
              >
                {expandedId === d.fileId ? '收起 diff' : '查看 diff'}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onIgnore(d.fileId)}>
                忽略
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => onAccept(d.fileId)}>
                采纳为新基线
              </Button>
            </div>
            <div className="px-3.5 py-2 text-[11px] leading-relaxed text-text-muted">
              磁盘内容已偏离基线（磁盘 {formatTime(d.diskModifiedAt)} / 基线{' '}
              {formatTime(d.baselineModifiedAt)}）。
              {d.stalePendingCount > 0 && (
                <span className="mt-1 block text-amber">
                  注意：该文件有 {d.stalePendingCount} 个待确认变更集已因基线失效被标记为「已失效」，需先处理外部改动。
                </span>
              )}
            </div>
            {expandedId === d.fileId && <DiffPreview fileId={d.fileId} busy={busy} onAccept={onAccept} />}
          </div>
        ))}
      </div>
    </div>
  )
}
