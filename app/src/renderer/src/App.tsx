import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle'
import { ChangeSetCard } from '@renderer/components/chat/ChangeSetCard'
import { VersionHistoryPanel } from '@renderer/components/chat/VersionHistoryPanel'
import { ExternalChangePanel } from '@renderer/components/chat/ExternalChangePanel'
import { ManualEditPanel } from '@renderer/components/chat/ManualEditPanel'
import { WordPreviewPanel } from '@renderer/components/chat/WordPreviewPanel'
import { ModelConfigPanel } from '@renderer/components/settings/ModelConfigPanel'
import { useUiStore } from '@renderer/store/ui-store'
import { LAYOUT_LIMITS } from '@renderer/store/types'
import type { AtomicChange } from '@shared/agent'
import type { FileRecord } from '@shared/db-protocol'

type IpcState = 'checking' | 'ok' | 'error'

// 会话气泡（T-S2-04 请求/响应形态 + T-S2-08③ 流式过程态）。
// role=system 专用于错误与拦截提示，与 assistant 的正常回复区分。
interface ChatBubble {
  id: number
  role: 'user' | 'assistant' | 'system'
  text: string
  // T-S2-08③ 流式轮次的工具状态行（非流式气泡无此字段）。
  toolLines?: ToolStatusLine[]
  // 流式进行中：token/工具事件渐进填充，终值由 onSuccess 的结构化结果覆盖。
  streaming?: boolean
}

// 工具调用状态行（T-S2-08③）：⏳ 执行中 / ✅ 产出 pending ChangeSet /
// ❌ 产出错误 ChangeSet（TEXT_NOT_FOUND 等可恢复错误）。仅作状态指示，
// 信任决策以 ChangeSetCard 展示的 pending ChangeSet 为唯一事实源（架构 §5）。
interface ToolStatusLine {
  callId: string
  toolName: string
  status: 'running' | 'ok' | 'error'
  error?: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

// FTS5 snippet() 以 [ ] 包裹命中词：渲染为 <mark> 高亮（T-S2-08）。
// 标记对可能被 snippet 截断切断——未闭合时按原文显示（诚实降级，不吞字）。
function renderSearchSnippet(snippet: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let rest = snippet
  let key = 0
  while (rest.length > 0) {
    const open = rest.indexOf('[')
    if (open === -1) {
      nodes.push(rest)
      break
    }
    if (open > 0) nodes.push(rest.slice(0, open))
    const close = rest.indexOf(']', open + 1)
    if (close === -1) {
      nodes.push(rest.slice(open))
      break
    }
    nodes.push(
      <mark key={key} className="rounded-xs bg-amber-soft px-0.5 text-text-body">
        {rest.slice(open + 1, close)}
      </mark>
    )
    key += 1
    rest = rest.slice(close + 1)
  }
  return nodes
}

function App(): React.JSX.Element {
  const [ipcState, setIpcState] = useState<IpcState>('checking')
  const [dark, setDark] = useState(false)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [bubbles, setBubbles] = useState<ChatBubble[]>([])
  const [prompt, setPrompt] = useState('')
  // 左栏搜索（T-S2-08）：输入防抖 250ms 后调 FTS5。trigram 分词支持中英文
  // 子串检索，metadata 列含文件名，故「按名称/按关键词」共用一条检索路径。
  const [searchText, setSearchText] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  // 手动微调面板重挂载序号（T-S2-05A）：提交成功时 +1，以 key 重挂载清空
  // 草稿（与 VersionHistoryPanel 切换文件重挂载的模式同源）。
  const [manualResetSeq, setManualResetSeq] = useState(0)
  // 右栏页签（T-S2-08）：预览为默认态——三栏骨架的主叙事是「左列表 / 中会话 /
  // 右预览」，手动微调作为第二页签；两页签保持挂载仅切 hidden，防草稿丢失。
  const [rightTab, setRightTab] = useState<'preview' | 'manual'>('preview')
  // 模型设置面板（T-S2-07）：多模型配置入口，密钥加解密全部在主进程闭环。
  const [modelPanelOpen, setModelPanelOpen] = useState(false)
  const bubbleSeq = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // T-S2-08③ 流式轮次登记：chatSend 发起时写入 { turnId, bubbleId }，
  // chat:stream 事件按 turnId 归属本轮；onSuccess/onError 统一置 null 封轮，
  // 迟到事件（重试重复 token 等）由此守卫自然丢弃。
  const streamTurnRef = useRef<{ turnId: string; bubbleId: number } | null>(null)

  const layout = useUiStore((s) => s.layout)
  const viewMode = useUiStore((s) => s.viewMode)
  const undo = useUiStore((s) => s.undo)
  const setWLeft = useUiStore((s) => s.setWLeft)
  const setWRight = useUiStore((s) => s.setWRight)
  const setComposerH = useUiStore((s) => s.setComposerH)
  const toggleLeft = useUiStore((s) => s.toggleLeftCollapsed)
  const toggleRight = useUiStore((s) => s.toggleRightCollapsed)
  const applyWindowWidth = useUiStore((s) => s.applyWindowWidth)
  const pushUndo = useUiStore((s) => s.pushUndo)
  const clearUndo = useUiStore((s) => s.clearUndo)
  const pruneUndo = useUiStore((s) => s.pruneUndo)

  const qc = useQueryClient()

  const filesQuery = useQuery({ queryKey: ['files'], queryFn: () => window.api.listFiles() })
  const pendingQuery = useQuery({
    queryKey: ['changesets', 'pending'],
    queryFn: () => window.api.listPendingChangesets()
  })

  const files = filesQuery.data ?? []
  // useMemo 固定空数组引用：pending 未就绪时避免 `?? []` 每渲染新建数组，
  // 触发下方自动滚动 useEffect 的依赖抖动（react-hooks/exhaustive-deps）。
  const pendingChangesets = useMemo(() => pendingQuery.data ?? [], [pendingQuery.data])
  // 未显式选择时回退到首个文件，避免「有文件却无会话对象」的死角。
  const selectedFile: FileRecord | null =
    files.find((f) => f.id === selectedFileId) ?? files[0] ?? null

  // 搜索态（T-S2-08）：无关键词时 enabled 守卫住不发起 IPC；空串/纯空白在
  // 主进程 SqliteFtsSearchRepository.query 已短路为 []，双层兜底。
  const searching = debouncedSearch.length > 0
  const searchQuery = useQuery({
    queryKey: ['file-search', debouncedSearch],
    queryFn: () => window.api.searchFiles(debouncedSearch),
    enabled: searching
  })
  const searchHits = searchQuery.data ?? null
  // 搜索态下列表收敛到命中文件；snippet 为 FTS5 snippet() 的 [ ] 标记文本。
  const visibleFiles =
    searching && searchHits
      ? files.filter((f) => searchHits.some((h) => h.fileId === f.id))
      : files
  // useMemo 固定引用：避免每渲染新建 Map 触发下方列表无谓重排。
  const snippetMap = useMemo(() => {
    const m = new Map<string, string>()
    if (searching && searchHits) for (const h of searchHits) m.set(h.fileId, h.snippet)
    return m
  }, [searching, searchHits])

  // 右栏预览 diff 覆盖层（T-S2-08）：当前文件全部待审变更（AI / 手动 / 外部
  // 三种来源合并），由 WordPreviewPanel 按 before 文本匹配预览段落高亮。
  const pendingChangesForFile = useMemo(() => {
    if (!selectedFile) return []
    const changes: AtomicChange[] = []
    for (const cs of pendingChangesets) {
      if (cs.fileId === selectedFile.id) changes.push(...cs.changes)
    }
    return changes
  }, [pendingChangesets, selectedFile])

  const pushBubble = (role: ChatBubble['role'], text: string): void => {
    bubbleSeq.current += 1
    setBubbles((prev) => [...prev, { id: bubbleSeq.current, role, text }])
  }

  // 对话一轮（T-S2-04 请求/响应 + T-S2-08③ 流式过程）：ChangeSet 由主进程
  // AgentService 落库，渲染层只负责刷新 pending 卡片，不在本地拼装信任数据。
  // 终值收口：成功时以结构化 finalMessage 覆盖流式拼接文本（兜底重试重复
  // token 的取舍，见 gateway 注释）；失败时保留已流出的部分文本 + 系统错误气泡。
  const sendMutation = useMutation({
    mutationFn: (vars: { fileId: string; text: string; turnId: string }) =>
      window.api.chatSend(vars.fileId, vars.text, vars.turnId),
    onSuccess: (res) => {
      const st = streamTurnRef.current
      streamTurnRef.current = null
      if (st) {
        setBubbles((prev) =>
          prev.map((b) =>
            b.id === st.bubbleId
              ? {
                  ...b,
                  text: res.ok
                    ? res.finalMessage || b.text || '本轮完成（无文本回复）。'
                    : b.text,
                  streaming: false
                }
              : b
          )
        )
      }
      if (!res.ok) {
        pushBubble(
          'system',
          `请求失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      }
      for (const tip of res.interceptions) pushBubble('system', `系统拦截：${tip}`)
      void qc.invalidateQueries({ queryKey: ['changesets'] })
    },
    onError: (err: Error) => {
      const st = streamTurnRef.current
      streamTurnRef.current = null
      if (st) {
        setBubbles((prev) =>
          prev.map((b) => (b.id === st.bubbleId ? { ...b, streaming: false } : b))
        )
      }
      pushBubble('system', `通信失败：${err.message}`)
    }
  })

  // 信任交互（架构 §5）：接受成功后基线已刷新，文件列表必须重取。
  const acceptMutation = useMutation({
    mutationFn: (vars: { id: string; acceptedChangeIds?: string[] }) =>
      window.api.acceptChangeset(vars.id, vars.acceptedChangeIds),
    onSuccess: (res) => {
      if (!res.ok) {
        pushBubble(
          'system',
          `应用失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      } else {
        pushBubble('assistant', `已写入文件（${res.appliedCount ?? 0} 处变更，状态 ${res.status}）。`)
      }
      void qc.invalidateQueries({ queryKey: ['changesets'] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      // 接受后 onApplied 已生成快照版本（T-S2-06）：版本历史与 diff 预览缓存同步失效。
      void qc.invalidateQueries({ queryKey: ['versions'] })
      void qc.invalidateQueries({ queryKey: ['version-diff'] })
      // T-S2-05A：正文已变，右栏手动微调的段落数据同步失效。
      void qc.invalidateQueries({ queryKey: ['paragraphs'] })
      // T-S2-08：正文已写入，右栏预览 HTML 同步失效（重转 mammoth + 重放 diff 覆盖层）。
      void qc.invalidateQueries({ queryKey: ['preview-html'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
  })

  const rejectMutation = useMutation({
    mutationFn: (id: string) => window.api.rejectChangeset(id),
    onSuccess: (res) => {
      if (!res.ok) {
        pushBubble(
          'system',
          `放弃失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      } else {
        pushBubble('assistant', '已放弃该变更集，文件保持不变。')
      }
      void qc.invalidateQueries({ queryKey: ['changesets'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
  })

  // 线性回溯（T-S2-06 / 架构 §5）：恢复成功后文件基线、版本链与 pending
  // 变更集全部变化（同文件 pending 已被回溯清理），四类缓存都要重取。
  const restoreMutation = useMutation({
    mutationFn: (versionId: string) => window.api.restoreVersion(versionId),
    onSuccess: (res) => {
      if (!res.ok) {
        pushBubble(
          'system',
          `恢复失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      } else {
        pushBubble(
          'assistant',
          `已恢复到目标版本（${res.appliedCount ?? 0} 处变更；回溯本身已生成新版本与反向 ChangeSet）。`
        )
      }
      void qc.invalidateQueries({ queryKey: ['versions'] })
      void qc.invalidateQueries({ queryKey: ['version-diff'] })
      void qc.invalidateQueries({ queryKey: ['changesets'] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      // T-S2-05A：正文已回退，右栏手动微调的段落数据同步失效。
      void qc.invalidateQueries({ queryKey: ['paragraphs'] })
      // T-S2-08：正文已回退，右栏预览 HTML 同步失效。
      void qc.invalidateQueries({ queryKey: ['preview-html'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
  })

  const importMutation = useMutation({
    mutationFn: () => window.api.importWord(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['files'] })
      const first = res.imported[0]
      if (first) setSelectedFileId(first.file.id)
      if (res.failures.length > 0) {
        pushBubble(
          'system',
          `部分文件导入失败：${res.failures.map((f) => `${f.path}（${f.reason}）`).join('；')}`
        )
      }
    },
    onError: (err: Error) => pushBubble('system', `导入失败：${err.message}`)
  })

  // —— T-S2-05A 手动微调与外部编辑感知（PRD 2A.6 / 架构 §5.1）——
  // 手动微调提交：主进程与磁盘基线逐段 diff，产出 source=manual 的 pending
  // ChangeSet；成功后重挂载编辑面板清空草稿，确认动作回到会话里的信任卡片。
  const manualSubmitMutation = useMutation({
    mutationFn: (vars: { fileId: string; editedParagraphs: { index: number; text: string }[] }) =>
      window.api.createManualChangeset(vars.fileId, vars.editedParagraphs),
    onSuccess: (res) => {
      if (!res.ok) {
        pushBubble(
          'system',
          `提交失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      } else if (res.changeSetId) {
        pushBubble(
          'assistant',
          `手动微调已提交（${res.changeCount ?? 0} 处变更），请在会话中确认应用。`
        )
        setManualResetSeq((n) => n + 1)
      } else {
        pushBubble('assistant', '没有检测到文本变化，未生成变更集。')
      }
      void qc.invalidateQueries({ queryKey: ['changesets'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
  })

  // 外部编辑采纳（架构 §5.1「单一事实源」）：ChangeSet(source=external) +
  // Version(author=external) + 基线前移；同文件 pending 已在检出时置 stale，
  // 这里集中失效全部相关缓存。
  const externalAcceptMutation = useMutation({
    mutationFn: (fileId: string) => window.api.acceptExternalChange(fileId),
    onSuccess: (res) => {
      if (!res.ok) {
        pushBubble(
          'system',
          `采纳失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      } else {
        pushBubble('assistant', '外部改动已采纳为新基线（已生成版本与变更记录）。')
      }
      void qc.invalidateQueries({ queryKey: ['external-detections'] })
      void qc.invalidateQueries({ queryKey: ['external-diff'] })
      void qc.invalidateQueries({ queryKey: ['changesets'] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      void qc.invalidateQueries({ queryKey: ['versions'] })
      void qc.invalidateQueries({ queryKey: ['version-diff'] })
      void qc.invalidateQueries({ queryKey: ['paragraphs'] })
      // T-S2-08：基线已前移，右栏预览 HTML 同步失效。
      void qc.invalidateQueries({ queryKey: ['preview-html'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
  })

  // 外部编辑忽略：仅推进基线（contentHash/size/modifiedAt），不落版本记录。
  const externalIgnoreMutation = useMutation({
    mutationFn: (fileId: string) => window.api.ignoreExternalChange(fileId),
    onSuccess: (res) => {
      if (!res.ok) {
        pushBubble(
          'system',
          `忽略失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      } else {
        pushBubble('assistant', '已忽略外部改动，基线已重定到当前磁盘内容。')
      }
      void qc.invalidateQueries({ queryKey: ['external-detections'] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      void qc.invalidateQueries({ queryKey: ['paragraphs'] })
      // T-S2-08：基线已重定，右栏预览 HTML 同步失效。
      void qc.invalidateQueries({ queryKey: ['preview-html'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
  })

  // 手动触发全量扫描（fs.watch 降级兜底）：scan 直接返回检出数组，
  // 写入 ['external-detections'] 缓存即可，无需再等轮询。
  const externalScanMutation = useMutation({
    mutationFn: () => window.api.scanExternalChanges(),
    onSuccess: (detections) => {
      qc.setQueryData(['external-detections'], detections)
      pushBubble('assistant', `扫描完成：${detections.length} 个文件检出外部改动。`)
    },
    onError: (err: Error) => pushBubble('system', `扫描失败：${err.message}`)
  })

  const sendPrompt = (): void => {
    const text = prompt.trim()
    if (!selectedFile || !text || sendMutation.isPending) return
    pushBubble('user', text)
    // T-S2-08③：生成本轮 turnId 并预置空流式气泡——token/工具状态事件
    // 渐进填充该气泡，IPC 结构化结果返回后由 onSuccess 终值收口。
    const turnId = crypto.randomUUID()
    bubbleSeq.current += 1
    const bubbleId = bubbleSeq.current
    streamTurnRef.current = { turnId, bubbleId }
    setBubbles((prev) => [...prev, { id: bubbleId, role: 'assistant', text: '', streaming: true }])
    setPrompt('')
    sendMutation.mutate({ fileId: selectedFile.id, text, turnId })
  }

  // Enter 发送、Shift+Enter 换行；isComposing 让路中文输入法选词阶段。
  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      sendPrompt()
    }
  }

  useEffect(() => {
    window.api
      .ping()
      .then((res) => setIpcState(res === 'pong' ? 'ok' : 'error'))
      .catch(() => setIpcState('error'))
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  // T-S2-08③ 流式事件订阅：挂载一次，cleanup 退订。handler 只引用
  // streamTurnRef / setBubbles（跨渲染稳定），不捕获组件态，重渲染不重注册；
  // setState 全部发生在事件回调内（异步于 effect body），非同步副作用。
  useEffect(() => {
    const unsubscribe = window.api.onChatStream((ev) => {
      const st = streamTurnRef.current
      // 跨轮守卫：迟到事件/其他窗口广播一律丢弃，只消费当前轮。
      if (!st || ev.turnId !== st.turnId) return
      setBubbles((prev) =>
        prev.map((b) => {
          if (b.id !== st.bubbleId) return b
          if (ev.kind === 'token') {
            return { ...b, text: b.text + ev.text }
          }
          if (ev.kind === 'tool-start') {
            const lines: ToolStatusLine[] = [
              ...(b.toolLines ?? []),
              { callId: ev.callId, toolName: ev.toolName, status: 'running' }
            ]
            return { ...b, toolLines: lines }
          }
          const lines: ToolStatusLine[] = (b.toolLines ?? []).map((l) =>
            l.callId === ev.callId
              ? { ...l, status: ev.ok ? 'ok' : 'error', ...(ev.error ? { error: ev.error } : {}) }
              : l
          )
          return { ...b, toolLines: lines }
        })
      )
    })
    return unsubscribe
  }, [])

  // 搜索防抖（T-S2-08）：250ms 停顿后才更新关键词触发 FTS5 查询，
  // 避免逐键抖动 IPC（trigram 查询本身轻，防抖只为收敛请求频率）。
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText.trim()), 250)
    return () => clearTimeout(t)
  }, [searchText])

  useEffect(() => {
    const onResize = (): void => applyWindowWidth(window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyWindowWidth])

  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => pruneUndo(), 1_000)
    return () => clearTimeout(t)
  }, [undo, pruneUndo])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [bubbles, pendingChangesets])

  const ipcBadge = {
    checking: { text: 'IPC 检测中…', cls: 'bg-amber-soft text-amber' },
    ok: { text: 'IPC 已连通', cls: 'bg-green-soft text-green' },
    error: { text: 'IPC 异常', cls: 'bg-red-soft text-red' }
  }[ipcState]

  const cols = [
    layout.leftCollapsed ? '0px' : `${layout.wLeft}px`,
    layout.leftCollapsed ? '0px' : 'auto',
    '1fr',
    layout.rightCollapsed ? '0px' : 'auto',
    layout.rightCollapsed ? '0px' : `${layout.wRight}px`
  ].join(' ')

  return (
    <div className="relative flex h-full flex-col bg-base text-text-body">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-head">My-work-office</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${ipcBadge.cls}`}>
            {ipcBadge.text}
          </span>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent-text">
            {layout.breakpoint} · {viewMode}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={toggleLeft}>
            {layout.leftCollapsed ? '展开左栏' : '折叠左栏'}
          </Button>
          <Button variant="ghost" size="sm" onClick={toggleRight}>
            {layout.rightCollapsed ? '展开右栏' : '折叠右栏'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setModelPanelOpen(true)}>
            模型设置
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => pushUndo('演示：应用了一次变更')}
          >
            模拟危险操作
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setDark((v) => !v)}>
            {dark ? '浅色' : '深色'}
          </Button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1" style={{ gridTemplateColumns: cols }}>
        <aside
          aria-label="文件列表"
          className="min-h-0 overflow-auto border-r border-border bg-surface-raised"
          hidden={layout.leftCollapsed}
        >
          <div className="p-3">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
              文件
            </h2>
            <Button
              variant="secondary"
              size="sm"
              className="mb-3 w-full"
              disabled={importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              {importMutation.isPending ? '导入中…' : '导入 Word…'}
            </Button>
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜索文件名 / 正文关键词"
              aria-label="搜索文件"
              className="mb-3 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs outline-none placeholder:text-text-faint focus:border-border-strong"
            />
            {files.length === 0 ? (
              <p className="text-xs text-text-muted">暂无文件，点击「导入 Word…」开始。</p>
            ) : searching && searchQuery.isError ? (
              <p className="text-xs text-red">
                搜索失败：{searchQuery.error?.message ?? '未知错误'}
              </p>
            ) : searching && searchQuery.isPending ? (
              <p className="text-xs text-text-muted">搜索中…</p>
            ) : searching && visibleFiles.length === 0 ? (
              <p className="text-xs text-text-muted">没有匹配「{debouncedSearch}」的文件。</p>
            ) : (
              <ul className="space-y-1">
                {visibleFiles.map((f) => {
                  const active = f.id === selectedFile?.id
                  const snippet = snippetMap.get(f.id)
                  return (
                    <li key={f.id}>
                      <button
                        onClick={() => setSelectedFileId(f.id)}
                        className={`w-full rounded-sm border px-2.5 py-1.5 text-left text-xs ${
                          active
                            ? 'border-accent bg-accent-soft text-accent-text'
                            : 'border-border-sub bg-surface text-text-body hover:bg-surface-hover'
                        }`}
                      >
                        <span className="block truncate font-medium">{f.name}</span>
                        {snippet !== undefined ? (
                          <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
                            {renderSearchSnippet(snippet)}
                          </span>
                        ) : (
                          <span className="mt-0.5 block text-[11px] text-text-muted">
                            {formatSize(f.size)} · {formatTime(f.modifiedAt)}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mt-4 space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
                能力（S3 即将上线）
              </p>
              <button
                disabled
                className="w-full cursor-not-allowed rounded-sm border border-dashed border-border-sub px-2.5 py-1.5 text-left text-xs text-text-faint"
              >
                知识库 · 灰态占位
              </button>
              <button
                disabled
                className="w-full cursor-not-allowed rounded-sm border border-dashed border-border-sub px-2.5 py-1.5 text-left text-xs text-text-faint"
              >
                生成初稿 · 灰态占位
              </button>
            </div>
          </div>
        </aside>

        {!layout.leftCollapsed && (
          <ResizeHandle
            orientation="vertical"
            label="调整文件列表宽度"
            value={layout.wLeft}
            min={LAYOUT_LIMITS.wLeft.min}
            max={LAYOUT_LIMITS.wLeft.max}
            onChange={setWLeft}
          />
        )}

        <section aria-label="会话" className="flex min-h-0 flex-col">
          <h2 className="shrink-0 truncate border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            会话{selectedFile ? ` · ${selectedFile.name}` : ''}
          </h2>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
            {/* T-S2-05A 外部编辑横幅（PRD 2A.6「不静默覆盖」）：置顶常显，无检出时组件自渲染 null。 */}
            <ExternalChangePanel
              busy={externalAcceptMutation.isPending || externalIgnoreMutation.isPending}
              scanning={externalScanMutation.isPending}
              onAccept={(fileId) => externalAcceptMutation.mutate(fileId)}
              onIgnore={(fileId) => externalIgnoreMutation.mutate(fileId)}
              onScan={() => externalScanMutation.mutate()}
            />
            {bubbles.length === 0 && pendingChangesets.length === 0 ? (
              <p className="text-sm text-text-muted">
                {selectedFile
                  ? `已选中「${selectedFile.name}」，描述你想对文档做的操作。`
                  : '先在左侧导入并选中一个 Word 文件。'}
              </p>
            ) : null}
            <div className="space-y-2.5">
              {bubbles.map((b) => (
                <div key={b.id} className={`flex ${b.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3.5 py-2 text-sm ${
                      b.role === 'user'
                        ? 'bg-accent text-white'
                        : b.role === 'assistant'
                          ? 'bg-surface-raised text-text-body'
                          : 'border border-amber/40 bg-amber-soft text-amber'
                    }`}
                  >
                    {/* T-S2-08③ 工具状态行：callId 配对起止事件，⏳/✅/❌ 指示执行态。 */}
                    {b.toolLines?.map((l) => (
                      <p key={l.callId} className="mb-1 text-xs text-text-muted">
                        {l.status === 'running' ? '⏳' : l.status === 'ok' ? '✅' : '❌'} {l.toolName}
                        {l.status === 'error' && l.error ? `：${l.error}` : ''}
                      </p>
                    ))}
                    {b.text}
                    {b.streaming ? <span className="ml-0.5 animate-pulse">▍</span> : null}
                  </div>
                </div>
              ))}
            </div>
            {pendingChangesets.map((cs) => (
              <ChangeSetCard
                key={cs.id}
                view={cs}
                busy={acceptMutation.isPending || rejectMutation.isPending}
                onAccept={(id, acceptedChangeIds) =>
                  acceptMutation.mutate({ id, acceptedChangeIds })
                }
                onReject={(id) => rejectMutation.mutate(id)}
              />
            ))}
            {/* 版本历史（T-S2-06）：key 切换文件时重挂载，展开态随之重置。 */}
            {selectedFile && (
              <VersionHistoryPanel
                key={selectedFile.id}
                file={selectedFile}
                busy={restoreMutation.isPending}
                onRestore={(versionId) => restoreMutation.mutate(versionId)}
              />
            )}
          </div>
          <div className="shrink-0 border-t border-border">
            <ResizeHandle
              orientation="horizontal"
              label="调整输入框高度"
              value={layout.composerH}
              min={LAYOUT_LIMITS.composerH.min}
              max={LAYOUT_LIMITS.composerH.max}
              invert
              onChange={setComposerH}
            />
            <div className="flex items-end gap-2 p-3 pt-2">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onComposerKeyDown}
                disabled={!selectedFile || sendMutation.isPending}
                placeholder={
                  sendMutation.isPending
                    ? '本轮处理中…'
                    : selectedFile
                      ? `对「${selectedFile.name}」下达指令…（Enter 发送，Shift+Enter 换行）`
                      : '先在左侧选择文件'
                }
                style={{ height: layout.composerH }}
                className="min-w-0 flex-1 resize-none rounded-sm border border-border bg-surface px-3 py-2 text-sm outline-none placeholder:text-text-faint disabled:opacity-60"
              />
              <Button
                className="h-9 shrink-0"
                size="sm"
                disabled={!selectedFile || !prompt.trim() || sendMutation.isPending}
                onClick={sendPrompt}
              >
                {sendMutation.isPending ? '处理中…' : '发送'}
              </Button>
            </div>
          </div>
        </section>

        {!layout.rightCollapsed && (
          <ResizeHandle
            orientation="vertical"
            label="调整预览面板宽度"
            value={layout.wRight}
            min={LAYOUT_LIMITS.wRight.min}
            max={LAYOUT_LIMITS.wRight.max}
            invert
            onChange={setWRight}
          />
        )}

        <section
          aria-label="预览与工件"
          className="flex min-h-0 flex-col border-l border-border"
          hidden={layout.rightCollapsed}
        >
          <div
            role="tablist"
            aria-label="右栏视图"
            className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5"
          >
            <button
              role="tab"
              id="mwo-rt-preview"
              aria-selected={rightTab === 'preview'}
              aria-controls="mwo-rt-panel"
              onClick={() => setRightTab('preview')}
              className={`rounded-xs px-2.5 py-1 text-xs font-medium ${
                rightTab === 'preview'
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-text-muted hover:bg-surface-hover'
              }`}
            >
              预览
            </button>
            <button
              role="tab"
              id="mwo-rt-manual"
              aria-selected={rightTab === 'manual'}
              aria-controls="mwo-rt-panel"
              onClick={() => setRightTab('manual')}
              className={`rounded-xs px-2.5 py-1 text-xs font-medium ${
                rightTab === 'manual'
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-text-muted hover:bg-surface-hover'
              }`}
            >
              手动微调
            </button>
          </div>
          <div
            id="mwo-rt-panel"
            role="tabpanel"
            aria-labelledby={rightTab === 'preview' ? 'mwo-rt-preview' : 'mwo-rt-manual'}
            className="min-h-0 flex-1 overflow-auto p-4"
          >
            {!selectedFile ? (
              <p className="text-sm text-text-muted">先在左侧选择文件后可预览或手动微调。</p>
            ) : (
              <>
                <div hidden={rightTab !== 'preview'}>
                  <WordPreviewPanel
                    key={selectedFile.id}
                    file={selectedFile}
                    pendingChanges={pendingChangesForFile}
                  />
                </div>
                <div hidden={rightTab !== 'manual'}>
                  <ManualEditPanel
                    key={`${selectedFile.id}:${manualResetSeq}`}
                    file={selectedFile}
                    busy={manualSubmitMutation.isPending}
                    onSubmit={(editedParagraphs) =>
                      manualSubmitMutation.mutate({ fileId: selectedFile.id, editedParagraphs })
                    }
                  />
                </div>
              </>
            )}
          </div>
        </section>
      </main>

      <ModelConfigPanel open={modelPanelOpen} onClose={() => setModelPanelOpen(false)} />

      {undo && (
        <div
          role="status"
          className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-2.5 text-sm shadow-lg"
        >
          <span className="text-text-body">{undo.lastAction}</span>
          <button
            onClick={clearUndo}
            className="rounded-sm bg-accent px-2.5 py-1 text-xs font-medium text-accent-text"
          >
            撤销
          </button>
        </div>
      )}
    </div>
  )
}

export default App
