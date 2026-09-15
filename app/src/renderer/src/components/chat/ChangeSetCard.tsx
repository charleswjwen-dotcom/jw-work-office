import { useState } from 'react'
import type { AtomicChange } from '@shared/agent'
import type { ChangeSetView } from '@shared/ipc'
import { Button } from '@renderer/components/ui/button'
import { diffWords, type DiffSegment } from '@renderer/lib/inline-diff'

// T-S2-05 信任交互卡片（架构 §5 数据流的渲染端终点），结构对齐
// ui-design/main-screen.html 的 .cs-card：cs-h（文件名 + kind 徽标 + 待确认）/
// cs-item（每条 AtomicChange 一行：词级内联高亮 + 勾选）/ cs-foot（放弃 / 部分应用 / 应用变更）。
// 部分接受语义：勾选集合即 acceptChangeset(id, acceptedChangeIds) 的入参；
// 全选时「应用变更」不传 ids，走 TrustService 的全部接受口径（勿删此约定说明）。

const KIND_LABEL: Record<AtomicChange['kind'], string> = {
  text: '替换',
  style: '样式',
  insert: '插入',
  delete: '删除',
  cell: '单元格',
  element: '元素',
  image: '图片'
}

// T-S2-05A 来源徽标：ai=AI 对话 / manual=应用内手动微调 / external=外部编辑采纳。
// Record 穷尽 ChangeSetView['source']，新增来源时 typecheck 强制同步。
const SOURCE_LABEL: Record<ChangeSetView['source'], string> = {
  ai: 'AI 对话',
  manual: '手动微调',
  external: '外部编辑'
}

const SOURCE_BADGE: Record<ChangeSetView['source'], string> = {
  ai: 'bg-accent-soft text-accent-text',
  manual: 'bg-green-soft text-green',
  external: 'bg-amber-soft text-amber'
}

// 与 TrustService.accept 同一判定口径：当前仅支持「paragraph 位置的 text 变更」
// （word.applyParagraphEdits 确定性重写，架构 §3.4）。UI 不提供无法履行的勾选。
function isApplicable(change: AtomicChange): boolean {
  return (
    change.location.type === 'paragraph' &&
    change.kind === 'text' &&
    typeof change.before?.text === 'string' &&
    typeof change.after?.text === 'string'
  )
}

// 单条变更的展示段：text 走词级 LCS；insert/delete 只有一侧文本时整体高亮。
function segmentsFor(change: AtomicChange): DiffSegment[] {
  const before = typeof change.before?.text === 'string' ? change.before.text : null
  const after = typeof change.after?.text === 'string' ? change.after.text : null
  if (before !== null && after !== null) return diffWords(before, after)
  if (after !== null) return after ? [{ type: 'add', text: after }] : []
  if (before !== null) return before ? [{ type: 'del', text: before }] : []
  return []
}

export interface ChangeSetCardProps {
  view: ChangeSetView
  busy?: boolean
  onAccept: (id: string, acceptedChangeIds?: string[]) => void
  onReject: (id: string) => void
}

export function ChangeSetCard({ view, busy, onAccept, onReject }: ChangeSetCardProps): React.JSX.Element {
  const rows = view.changes.map((change) => ({
    change,
    applicable: isApplicable(change),
    segs: segmentsFor(change)
  }))
  // 默认全选（全部接受是信任交互的默认路径，§5）；仅可应用项进入勾选集合。
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.applicable).map((r) => r.change.id))
  )

  const selectable = rows.filter((r) => r.applicable)
  const total = selectable.length
  const selected = selectable.filter((r) => acceptedIds.has(r.change.id)).length
  const allSelected = total > 0 && selected === total
  const partial = selected > 0 && selected < total

  const toggle = (id: string): void => {
    setAcceptedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const kindPill = `${[...new Set(rows.map((r) => KIND_LABEL[r.change.kind]))].join('/')} · ${rows.length} 处`

  return (
    <div className="mt-2.5 overflow-hidden rounded-sm border border-border bg-surface-raised shadow-sm">
      <div className="flex items-center gap-2.5 border-b border-border-sub px-3.5 py-2.5">
        <span
          className="min-w-0 truncate text-[12.5px] font-semibold text-text-head"
          title={view.sourceCommand ?? undefined}
        >
          变更集 · {view.fileName}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${SOURCE_BADGE[view.source]}`}
        >
          {SOURCE_LABEL[view.source]}
        </span>
        <span className="shrink-0 rounded-sm border border-border px-1.5 py-px font-mono text-[10px] text-text-muted">
          {kindPill}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 rounded-full bg-amber-soft px-2 py-0.5 text-[11px] text-amber">
          待确认
        </span>
      </div>

      {rows.map(({ change, applicable, segs }) => (
        <div key={change.id} className="border-t border-border-sub px-3.5 py-1.5">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 shrink-0 accent-accent"
              checked={acceptedIds.has(change.id)}
              disabled={!applicable || busy}
              onChange={() => toggle(change.id)}
            />
            <div className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">
              <span className="mr-1.5 font-mono text-[10px] text-text-muted">
                {KIND_LABEL[change.kind]} ·{' '}
                {change.location.type === 'paragraph'
                  ? `¶${change.location.index}`
                  : change.location.type}
              </span>
              {segs.map((seg, i) => {
                if (seg.type === 'equal') return <span key={i}>{seg.text}</span>
                if (seg.type === 'del')
                  return (
                    <span key={i} className="rounded-sm bg-red-soft px-1 text-red line-through">
                      {seg.text}
                    </span>
                  )
                return (
                  <span key={i} className="rounded-sm bg-green-soft px-1 text-green">
                    {seg.text}
                  </span>
                )
              })}
              {!applicable && (
                <span className="ml-1.5 rounded-full bg-surface px-1.5 py-px font-sans text-[10px] text-text-faint">
                  暂不支持应用
                </span>
              )}
            </div>
          </label>
        </div>
      ))}

      <div className="flex items-center gap-2 border-t border-border-sub bg-base px-3.5 py-2.5">
        <span className="mr-auto text-[11px] text-text-muted">
          已选 {selected} / {total} 项
        </span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReject(view.id)}>
          放弃
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !partial}
          onClick={() => onAccept(view.id, [...acceptedIds])}
        >
          部分应用
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || selected === 0}
          onClick={() => onAccept(view.id, allSelected ? undefined : [...acceptedIds])}
        >
          应用变更
        </Button>
      </div>
    </div>
  )
}
