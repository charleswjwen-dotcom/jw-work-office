import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  label: string
  invert?: boolean
  step?: number
  onChange: (next: number) => void
}

export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  label,
  invert = false,
  step = 16,
  onChange
}: ResizeHandleProps): React.JSX.Element {
  const dragging = useRef(false)
  const start = useRef({ pos: 0, value: 0 })

  const isVertical = orientation === 'vertical'

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true
      start.current = { pos: isVertical ? e.clientX : e.clientY, value }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [isVertical, value]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const cur = isVertical ? e.clientX : e.clientY
      const delta = cur - start.current.pos
      const signed = invert ? -delta : delta
      onChange(start.current.value + signed)
    },
    [isVertical, invert, onChange]
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const decKey = isVertical ? 'ArrowLeft' : 'ArrowUp'
      const incKey = isVertical ? 'ArrowRight' : 'ArrowDown'
      if (e.key === decKey) {
        e.preventDefault()
        onChange(value - (invert ? -step : step))
      } else if (e.key === incKey) {
        e.preventDefault()
        onChange(value + (invert ? -step : step))
      } else if (e.key === 'Home') {
        e.preventDefault()
        onChange(min)
      } else if (e.key === 'End') {
        e.preventDefault()
        onChange(max)
      }
    },
    [isVertical, invert, step, value, min, max, onChange]
  )

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className={
        isVertical
          ? 'group relative z-10 -mx-1 w-2 cursor-col-resize outline-none'
          : 'group relative z-10 -my-1 h-2 cursor-row-resize outline-none'
      }
    >
      <span
        className={
          isVertical
            ? 'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent'
            : 'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent'
        }
      />
    </div>
  )
}
