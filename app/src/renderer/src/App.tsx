import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle'
import { useUiStore } from '@renderer/store/ui-store'
import { LAYOUT_LIMITS } from '@renderer/store/types'

type IpcState = 'checking' | 'ok' | 'error'

function App(): React.JSX.Element {
  const [ipcState, setIpcState] = useState<IpcState>('checking')
  const [dark, setDark] = useState(false)

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
            <input
              disabled
              placeholder="搜索文件 / 关键词（FTS5，待 T-S2-02）"
              className="mb-3 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs outline-none placeholder:text-text-faint"
            />
            <p className="text-xs text-text-muted">暂无文件，拖入 Word / Excel / PPT 开始。</p>
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
          <h2 className="shrink-0 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            会话
          </h2>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <p className="text-sm text-text-muted">
              与办公智能体对话的区域（消息气泡 / 流式输出 / ChangeSet 卡片待 T-S2-04/05）。
            </p>
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
            <div className="p-3 pt-2">
              <textarea
                disabled
                placeholder="描述你想对文档做的操作…（骨架阶段暂不可用）"
                style={{ height: layout.composerH }}
                className="w-full resize-none rounded-sm border border-border bg-surface px-3 py-2 text-sm outline-none placeholder:text-text-faint"
              />
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
          <h2 className="shrink-0 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            预览 / 工件
          </h2>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <p className="text-sm text-text-muted">
              预览与 diff 工件区（Word mammoth 预览 + diff 高亮待 T-S2-03/05）。
            </p>
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
