import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FileRecord } from '@shared/db-protocol'
import type { AtomicChange } from '@shared/agent'

// 右栏 Word 预览面板（T-S2-08 第②项，PRD 2A.2 / 架构 §3.4 预览轨）。
// html 来自主进程 preview:getHtml：mammoth 转换（file-worker）+ 白名单消毒
// （主进程，见 html-sanitizer.ts）之后才跨 IPC，渲染层直接 dangerouslySetInnerHTML
// 注入——消毒是主进程职责，渲染层不做任何安全判断（勿删此口径说明）。
// diff 覆盖层：待审变更按 before.text 归一化文本匹配预览段落（p/li/h1-h6/
// td/th/blockquote）加 .mwo-pv-hit 琥珀高亮。按文本而非段落索引匹配——
// 索引在表格/列表结构下与 mammoth 输出不可靠对应；插入类变更无 before 文本
// 无法定位，属已知局限（图例如实展示「待审 N 处 · 高亮 M 处」）。

const HIT_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote'

// 归一化：折叠全部空白为单空格并去首尾——对齐抽取轨 splitParagraphs 与
// mammoth HTML 对同一段落的空白差异（换行/多空格/缩进）。
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export interface WordPreviewPanelProps {
  file: FileRecord
  pendingChanges: AtomicChange[]
}

export function WordPreviewPanel({
  file,
  pendingChanges
}: WordPreviewPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLSpanElement>(null)

  const previewQuery = useQuery({
    queryKey: ['preview-html', file.id],
    queryFn: () => window.api.getPreviewHtml(file.id)
  })
  const res = previewQuery.data
  const html = res?.ok && res.html !== undefined ? res.html : null

  // diff 覆盖层 + 图例计数：html（内容基线）或待审变更变化时重放。先清旧类
  // 再匹配，保证幂等——React 对相同 html 字符串不会重设 innerHTML，但组件
  // 重挂载/缓存失效后重取的 html 可能同串不同 DOM，靠清类兜底。图例计数
  // 同样直写 DOM 而非 setState——effect 内同步 setState 会级联重渲染
  // （react-hooks/set-state-in-effect）；React 对相同 children 不重写文本，
  // 故 effect 写入的计数可跨 isFetching 等无关重渲染存活。
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    for (const el of Array.from(root.querySelectorAll('.mwo-pv-hit'))) {
      el.classList.remove('mwo-pv-hit')
      el.removeAttribute('title')
    }
    const targets: { before: string; after: string | null }[] = []
    for (const change of pendingChanges) {
      if (typeof change.before?.text === 'string' && change.before.text.trim().length > 0) {
        targets.push({
          before: normalizeText(change.before.text),
          after: change.after?.text ?? null
        })
      }
    }
    let hits = 0
    for (const el of Array.from(root.querySelectorAll(HIT_SELECTOR))) {
      const norm = normalizeText(el.textContent ?? '')
      const target = targets.find((t) => t.before === norm)
      if (!target) continue
      el.classList.add('mwo-pv-hit')
      el.setAttribute(
        'title',
        target.after ? `待审变更 → ${target.after}` : '待审变更：该段落将被删除'
      )
      hits += 1
    }
    const legend = legendRef.current
    if (legend) {
      legend.textContent =
        pendingChanges.length === 0
          ? '无待审变更'
          : `待审 ${pendingChanges.length} 处 · 高亮 ${hits} 处`
    }
  }, [html, pendingChanges])

  if (previewQuery.isPending)
    return <p className="text-sm text-text-muted">正在生成预览…</p>
  if (previewQuery.isError)
    return <p className="text-sm text-red">预览失败：{previewQuery.error.message}</p>
  if (!res?.ok)
    return (
      <p className="text-sm text-red">
        无法生成预览 [{res?.error?.code ?? 'UNKNOWN'}]：{res?.error?.message ?? '未知错误'}
      </p>
    )
  if (html === null) return <p className="text-sm text-text-muted">该文档没有可预览的内容。</p>

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">文档预览</h3>
        {previewQuery.isFetching && <span className="text-[10px] text-text-faint">刷新中…</span>}
        <span className="flex-1" />
        <span ref={legendRef} className="font-mono text-[10px] text-text-faint">
          {pendingChanges.length === 0
            ? '无待审变更'
            : `待审 ${pendingChanges.length} 处 · 匹配中…`}
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
        琥珀色高亮为待审变更涉及的段落（按文本匹配，悬停查看修改后内容）；接受 / 放弃变更后预览自动刷新。
      </p>
      <div ref={containerRef} className="mwo-preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
