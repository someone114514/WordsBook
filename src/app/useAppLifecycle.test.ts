import { describe, expect, it } from 'vitest'
import { calculateKeyboardInset, detectStandaloneMode } from './useAppLifecycle'

describe('app lifecycle viewport helpers', () => {
  it('calculates the covered keyboard area without returning negative values', () => {
    expect(calculateKeyboardInset(844, 524, 0)).toBe(320)
    expect(calculateKeyboardInset(844, 844, 0)).toBe(0)
    expect(calculateKeyboardInset(844, 900, 0)).toBe(0)
    expect(calculateKeyboardInset(Number.NaN, 500, 0)).toBe(0)
  })

  it('recognizes both standards-based and iOS standalone launches', () => {
    expect(detectStandaloneMode(true, false)).toBe(true)
    expect(detectStandaloneMode(false, true)).toBe(true)
    expect(detectStandaloneMode(false, false)).toBe(false)
  })
})
