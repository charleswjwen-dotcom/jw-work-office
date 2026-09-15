import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle'
import { ChangeSetCard } from '@renderer/components/chat/ChangeSetCard'
import { VersionHistoryPanel } from '@renderer/components/chat/VersionHistoryPanel'
import { ExternalChangePanel } from '@renderer/components/chat/ExternalChangePanel'
import { ManualEditPanel } from '@renderer/components/chat/ManualEditPanel'
import { useUiStore } from '@renderer/store/ui-store'
import { LAYOUT_LIMITS } from '@renderer/store/types'
import type { FileRecord } from '@shared/db-protocol'

type IpcState = 'checking' | 'ok' | 'error'

// 会话气泡（T-S2-04 请求/响应形态；流式输出属 T-S2-06）。
// role=system 专用于错误与拦截提示，与 assistant 的正常回复区分。
interface ChatBubble {
  id: number
  role: 'user' | 'assistant' | 'system'
  text: string
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

function App(): React.JSX.Element {
  const [ipcState, setIpcState] = useState<IpcState>('checking')
  const [dark, setDark] = useState(false)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [bubbles, setBubbles] = useState<ChatBubble[]>([])
  const [prompt, setPrompt] = useState('')
  // 手动微调面板重挂载序号（T-S2-05A）：提交成功时 +1，以 key 重挂载清空
  // 草稿（与 VersionHistoryPanel 切换文件重挂载的模式同源）。
  const [manualResetSeq, setManualResetSeq] = useState(0)
  const bubbleSeq = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const pushBubble = (role: ChatBubble['role'], text: string): void => {
    bubbleSeq.current += 1
    setBubbles((prev) => [...prev, { id: bubbleSeq.current, role, text }])
  }

  // 对话一轮（T-S2-04）：ChangeSet 由主进程 AgentService 落库，
  // 渲染层只负责刷新 pending 卡片，不在本地拼装信任数据。
  const sendMutation = useMutation({
    mutationFn: (vars: { fileId: string; text: string }) =>
      window.api.chatSend(vars.fileId, vars.text),
    onSuccess: (res) => {
      if (res.ok) {
        pushBubble('assistant', res.finalMessage || '本轮完成（无文本回复）。')
      } else {
        pushBubble(
          'system',
          `请求失败 [${res.error?.code ?? 'UNKNOWN'}]：${res.error?.message ?? '未知错误'}`
        )
      }
      for (const tip of res.interceptions) pushBubble('system', `系统拦截：${tip}`)
      void qc.invalidateQueries({ queryKey: ['changesets'] })
    },
    onError: (err: Error) => pushBubble('system', `通信失败：${err.message}`)
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
    setPrompt('')
    sendMutation.mutate({ fileId: selectedFile.id, text })
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
              disabled
              placeholder="搜索文件 / 关键词（FTS5，待后续任务）"
              className="mb-3 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs outline-none placeholder:text-text-faint"
            />
            {files.length === 0 ? (
              <p className="text-xs text-text-muted">暂无文件，点击「导入 Word…」开始。</p>
            ) : (
              <ul className="space-y-1">
                {files.map((f) => {
                  const active = f.id === selectedFile?.id
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
                        <span className="mt-0.5 block text-[11px] text-text-muted">
                          {formatSize(f.size)} · {formatTime(f.modifiedAt)}
                        </span>
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
                    {b.text}
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
          aria-label="手动微调与工件"
          className="flex min-h-0 flex-col border-l border-border"
          hidden={layout.rightCollapsed}
        >
          <h2 className="shrink-0 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            手动微调 / 工件
          </h2>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {selectedFile ? (
              <ManualEditPanel
                key={`${selectedFile.id}:${manualResetSeq}`}
                file={selectedFile}
                busy={manualSubmitMutation.isPending}
                onSubmit={(editedParagraphs) =>
                  manualSubmitMutation.mutate({ fileId: selectedFile.id, editedParagraphs })
                }
              />
            ) : (
              <p className="text-sm text-text-muted">先在左侧选择文件后可手动微调段落。</p>
            )}
          </div>
        </section>
      </main>

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
