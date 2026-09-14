import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  clampLayout,
  deriveBreakpoint,
  DEFAULT_PREFS,
  type Breakpoint,
  type CompareMode,
  type PendingChange,
  type RightPanel,
  type TrustMode,
  type UiPrefs,
  type UiState,
  type ViewMode
} from './types'

const UNDO_TTL_MS = 10_000

interface UiActions {
  setViewMode: (mode: ViewMode) => void
  setActivePanel: (panel: RightPanel) => void
  setPreviewFmt: (fmt: string) => void
  setCompareMode: (mode: CompareMode) => void
  setTrustMode: (mode: TrustMode) => void

  setWLeft: (px: number) => void
  setWRight: (px: number) => void
  setComposerH: (px: number) => void
  toggleLeftCollapsed: () => void
  toggleRightCollapsed: () => void
  applyWindowWidth: (width: number) => void

  setPending: (pending: PendingChange | null) => void
  pushUndo: (lastAction: string, now?: number) => void
  clearUndo: () => void
  pruneUndo: (now?: number) => void

  resetLayout: () => void
}

export type UiStore = UiState & UiActions

function initialLayout(): UiState['layout'] {
  return { ...DEFAULT_PREFS, breakpoint: 'wide' as Breakpoint }
}

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      viewMode: 'chat',
      layout: initialLayout(),
      activePanel: 'progress',
      previewFmt: 'word',
      compareMode: 'split',
      trustMode: 'manual',
      pending: null,
      undo: null,

      setViewMode: (viewMode) => set({ viewMode }),
      setActivePanel: (activePanel) => set({ activePanel }),
      setPreviewFmt: (previewFmt) => set({ previewFmt }),
      setCompareMode: (compareMode) => set({ compareMode }),
      setTrustMode: (trustMode) => set({ trustMode }),

      setWLeft: (px) =>
        set((s) => ({ layout: { ...s.layout, wLeft: clampLayout(px, 'wLeft') } })),
      setWRight: (px) =>
        set((s) => ({ layout: { ...s.layout, wRight: clampLayout(px, 'wRight') } })),
      setComposerH: (px) =>
        set((s) => ({ layout: { ...s.layout, composerH: clampLayout(px, 'composerH') } })),
      toggleLeftCollapsed: () =>
        set((s) => ({ layout: { ...s.layout, leftCollapsed: !s.layout.leftCollapsed } })),
      toggleRightCollapsed: () =>
        set((s) => ({ layout: { ...s.layout, rightCollapsed: !s.layout.rightCollapsed } })),

      applyWindowWidth: (width) =>
        set((s) => {
          const breakpoint = deriveBreakpoint(width)
          const autoRight = breakpoint !== 'wide'
          return {
            layout: {
              ...s.layout,
              breakpoint,
              rightCollapsed: autoRight ? true : s.layout.rightCollapsed
            }
          }
        }),

      setPending: (pending) => set({ pending }),

      pushUndo: (lastAction, now = Date.now()) =>
        set({ undo: { lastAction, expiresAt: now + UNDO_TTL_MS } }),
      clearUndo: () => set({ undo: null }),
      pruneUndo: (now = Date.now()) => {
        const { undo } = get()
        if (undo && undo.expiresAt <= now) set({ undo: null })
      },

      resetLayout: () => set({ layout: { ...initialLayout(), breakpoint: get().layout.breakpoint } })
    }),
    {
      name: 'mwo.ui-prefs',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): { layout: UiPrefs } => ({
        layout: {
          wLeft: state.layout.wLeft,
          wRight: state.layout.wRight,
          composerH: state.layout.composerH,
          leftCollapsed: state.layout.leftCollapsed,
          rightCollapsed: state.layout.rightCollapsed
        }
      }),
      merge: (persisted, current) => {
        const prefs = (persisted as { layout?: Partial<UiPrefs> } | undefined)?.layout ?? {}
        return {
          ...current,
          layout: { ...current.layout, ...prefs }
        }
      }
    }
  )
)
