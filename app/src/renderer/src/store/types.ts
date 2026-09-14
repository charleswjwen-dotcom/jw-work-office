export type ViewMode = 'chat' | 'preview' | 'kb-lib' | 'kb-gen'
export type Breakpoint = 'wide' | 'medium' | 'narrow'
export type RightPanel = 'progress' | 'pinned' | 'context'
export type CompareMode = 'split' | 'single'
export type TrustMode = 'manual' | 'auto-low-risk' | 'fast-pass'
export type RiskLevel = 'low' | 'mid' | 'high'

export interface LayoutState {
  wLeft: number
  wRight: number
  composerH: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  breakpoint: Breakpoint
}

export interface PendingChange {
  changeSetId: string
  risk: RiskLevel
}

export interface UndoEntry {
  lastAction: string
  expiresAt: number
}

export interface UiState {
  viewMode: ViewMode
  layout: LayoutState
  activePanel: RightPanel
  previewFmt: string
  compareMode: CompareMode
  trustMode: TrustMode
  pending: PendingChange | null
  undo: UndoEntry | null
}

export interface UiPrefs {
  wLeft: number
  wRight: number
  composerH: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

export const LAYOUT_LIMITS = {
  wLeft: { min: 180, max: 420 },
  wRight: { min: 260, max: 520 },
  composerH: { min: 44, max: 320 }
} as const

export const BREAKPOINT_THRESHOLDS = {
  wide: 1100,
  medium: 900
} as const

export const DEFAULT_PREFS: UiPrefs = {
  wLeft: 248,
  wRight: 336,
  composerH: 96,
  leftCollapsed: false,
  rightCollapsed: false
}

export function clampLayout(value: number, key: keyof typeof LAYOUT_LIMITS): number {
  const { min, max } = LAYOUT_LIMITS[key]
  return Math.min(max, Math.max(min, value))
}

export function deriveBreakpoint(width: number): Breakpoint {
  if (width >= BREAKPOINT_THRESHOLDS.wide) return 'wide'
  if (width >= BREAKPOINT_THRESHOLDS.medium) return 'medium'
  return 'narrow'
}
