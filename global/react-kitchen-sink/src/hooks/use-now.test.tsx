import { renderHook } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useNowDay, useNowMillis } from './use-now.ts'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNowMillis', () => {
  it('floors the current instant to the start of the quantum window', () => {
    // Arrange
    vi.setSystemTime(new Date('2026-09-04T13:37:41.123Z'))
    const quantumMs = 60_000

    // Act
    const { result } = renderHook(() => useNowMillis(quantumMs))

    // Assert
    expect(result.current % quantumMs).toBe(0)
    expect(result.current).toBe(Math.floor(Date.now() / quantumMs) * quantumMs)
  })

  it('returns the same cached value while now stays within one window', () => {
    // A snapshot that changed within a window is exactly what trips React's
    // consistency check; assert it does not.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 24 * 60 * 60 * 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (quantumMs, advanceMs) => {
          // Arrange: land inside a window with room to advance without crossing it.
          vi.setSystemTime(quantumMs * 100)
          const { result, rerender } = renderHook(() => useNowMillis(quantumMs))
          const first = result.current

          // Act: advance by less than the remaining window.
          vi.setSystemTime(quantumMs * 100 + Math.min(advanceMs, quantumMs - 1))
          rerender()

          // Assert
          expect(result.current).toBe(first)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
    'throws a RangeError on non-positive or non-finite quantumMs (%s)',
    (bad) => {
      expect(() => renderHook(() => useNowMillis(bad))).toThrow(RangeError)
    }
  )

  it('advances to the next window once the boundary is crossed', () => {
    // Arrange
    const quantumMs = 1000
    vi.setSystemTime(quantumMs * 5)
    const { result, rerender } = renderHook(() => useNowMillis(quantumMs))
    expect(result.current).toBe(quantumMs * 5)

    // Act
    vi.setSystemTime(quantumMs * 6 + 10)
    rerender()

    // Assert
    expect(result.current).toBe(quantumMs * 6)
  })
})

describe('useNowDay', () => {
  it('returns the local calendar day as YYYY-MM-DD', () => {
    // Arrange: noon local keeps the day unambiguous regardless of the runner's zone.
    vi.setSystemTime(new Date('2026-09-04T12:00:00'))

    // Act
    const { result } = renderHook(() => useNowDay())

    // Assert
    expect(result.current).toBe('2026-09-04')
  })

  it('returns the same cached string across re-renders on the same day', () => {
    // Arrange
    vi.setSystemTime(new Date('2026-09-04T08:00:00'))
    const { result, rerender } = renderHook(() => useNowDay())
    const first = result.current

    // Act: same day, later hour.
    vi.setSystemTime(new Date('2026-09-04T20:00:00'))
    rerender()

    // Assert
    expect(result.current).toBe(first)
  })
})
