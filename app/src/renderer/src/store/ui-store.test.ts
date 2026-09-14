import { describe, it, expect, beforeEach } from 'vitest'
import { clampLayout, deriveBreakpoint, LAYOUT_LIMITS, DEFAULT_PREFS } from './types'
import { useUiStore } from './ui-store'
import { memoryStore } from '@renderer/test/setup'

beforeEach(() => {
  memoryStore.clear()
})

describe('clampLayout', () => {
  it('clamps below min and above max', () => {
    expect(clampLayout(10, 'wLeft')).toBe(LAYOUT_LIMITS.wLeft.min)
    expect(clampLayout(9999, 'wLeft')).toBe(LAYOUT_LIMITS.wLeft.max)
    expect(clampLayout(320, 'wRight')).toBe(320)
  })

  it('enforces composer height limits', () => {
    expect(clampLayout(10, 'composerH')).toBe(LAYOUT_LIMITS.composerH.min)
    expect(clampLayout(999, 'composerH')).toBe(LAYOUT_LIMITS.composerH.max)
  })
})

describe('deriveBreakpoint', () => {
  it('maps width to the three frozen breakpoints (1100 / 900)', () => {
    expect(deriveBreakpoint(1440)).toBe('wide')
    expect(deriveBreakpoint(1100)).toBe('wide')
    expect(deriveBreakpoint(1099)).toBe('medium')
    expect(deriveBreakpoint(900)).toBe('medium')
    expect(deriveBreakpoint(899)).toBe('narrow')
  })
})

describe('useUiStore', () => {
  it('holds the frozen UiState shape and defaults', () => {
    const s = useUiStore.getState()
    expect(s.viewMode).toBe('chat')
    expect(s.activePanel).toBe('progress')
    expect(s.compareMode).toBe('split')
    expect(s.trustMode).toBe('manual')
    expect(s.previewFmt).toBe('word')
    expect(s.pending).toBeNull()
    expect(s.undo).toBeNull()
    expect(s.layout.wLeft).toBe(DEFAULT_PREFS.wLeft)
    expect(s.layout.breakpoint).toBe('wide')
  })

  it('clamps layout setters', () => {
    useUiStore.getState().setWLeft(1)
    expect(useUiStore.getState().layout.wLeft).toBe(LAYOUT_LIMITS.wLeft.min)
    useUiStore.getState().setComposerH(9999)
    expect(useUiStore.getState().layout.composerH).toBe(LAYOUT_LIMITS.composerH.max)
  })

  it('auto-collapses right rail outside wide breakpoint', () => {
    useUiStore.getState().applyWindowWidth(1000)
    expect(useUiStore.getState().layout.breakpoint).toBe('medium')
    expect(useUiStore.getState().layout.rightCollapsed).toBe(true)
    useUiStore.getState().applyWindowWidth(1440)
    expect(useUiStore.getState().layout.breakpoint).toBe('wide')
  })

  it('toggles collapse flags', () => {
    const before = useUiStore.getState().layout.leftCollapsed
    useUiStore.getState().toggleLeftCollapsed()
    expect(useUiStore.getState().layout.leftCollapsed).toBe(!before)
    useUiStore.getState().toggleLeftCollapsed()
  })

  it('records undo with TTL and prunes when expired', () => {
    useUiStore.getState().pushUndo('apply-change-set', 1_000)
    const undo = useUiStore.getState().undo
    expect(undo?.lastAction).toBe('apply-change-set')
    expect(undo?.expiresAt).toBe(11_000)
    useUiStore.getState().pruneUndo(11_001)
    expect(useUiStore.getState().undo).toBeNull()
  })

  it('persists only layout prefs (partialize contract)', () => {
    useUiStore.getState().setViewMode('preview')
    useUiStore.getState().setWLeft(300)
    const raw = localStorage.getItem('mwo.ui-prefs')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.layout.wLeft).toBe(300)
    expect(parsed.state.viewMode).toBeUndefined()
    expect(parsed.state.undo).toBeUndefined()
  })
})
