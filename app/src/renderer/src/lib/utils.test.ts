import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('dedupes conflicting tailwind classes (last wins)', () => {
    expect(cn('px-2', 'px-3')).toBe('px-3')
  })

  it('handles conditional falsy values', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b')
  })
})
