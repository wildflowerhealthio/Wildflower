import { act, renderHook } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useDebouncedCallback } from './use-debounced-callback.ts'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const DELAY = 400

describe('useDebouncedCallback', () => {
  it('runs once, with the last arguments, after the quiet period', () => {
    // Arrange
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, DELAY))

    // Act — three calls in quick succession
    act(() => {
      result.current.call('a')
      result.current.call('ab')
      result.current.call('abc')
    })
    expect(spy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(DELAY)
    })

    // Assert — the intermediate arguments never run
    expect(spy.mock.calls).toEqual([['abc']])
  })

  it('restarts the quiet period on each call rather than firing on a fixed schedule', () => {
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, DELAY))

    act(() => result.current.call('a'))
    act(() => {
      vi.advanceTimersByTime(DELAY - 1)
    })
    act(() => result.current.call('b'))
    act(() => {
      vi.advanceTimersByTime(DELAY - 1)
    })

    // A typist who never pauses for the full delay has not committed yet.
    expect(spy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(spy.mock.calls).toEqual([['b']])
  })

  it('flush runs the scheduled call immediately and only once', () => {
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, DELAY))

    act(() => result.current.call('now'))
    act(() => result.current.flush())

    expect(spy.mock.calls).toEqual([['now']])
    // The timer must not fire a second time behind the flush.
    act(() => {
      vi.advanceTimersByTime(DELAY * 2)
    })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('flush with nothing scheduled does nothing', () => {
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, DELAY))

    act(() => result.current.flush())
    act(() => {
      vi.advanceTimersByTime(DELAY)
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('cancel drops the scheduled call', () => {
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, DELAY))

    act(() => result.current.call('dropped'))
    act(() => result.current.cancel())
    act(() => {
      vi.advanceTimersByTime(DELAY * 2)
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('runs the latest rendered callback, not the one captured when scheduled', () => {
    // The whole reason the hook exists: a callback closing over fresh props
    // must not fire with the values it closed over at schedule time.
    const calls: string[] = []
    const { result, rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        useDebouncedCallback((value: string) => calls.push(`${tag}:${value}`), DELAY),
      { initialProps: { tag: 'first' } }
    )

    act(() => result.current.call('x'))
    rerender({ tag: 'second' })
    act(() => {
      vi.advanceTimersByTime(DELAY)
    })

    expect(calls).toEqual(['second:x'])
  })

  it('keeps call, flush and cancel referentially stable across renders', () => {
    const { result, rerender } = renderHook(
      ({ tag }: { tag: string }) => useDebouncedCallback(() => tag, DELAY),
      { initialProps: { tag: 'first' } }
    )
    const before = result.current

    rerender({ tag: 'second' })

    // Stable identity is what makes the handle safe in a dependency array.
    expect(result.current.call).toBe(before.call)
    expect(result.current.flush).toBe(before.flush)
    expect(result.current.cancel).toBe(before.cancel)
  })

  it('drops a scheduled call on unmount', () => {
    const spy = vi.fn()
    const { result, unmount } = renderHook(() => useDebouncedCallback(spy, DELAY))

    act(() => result.current.call('gone'))
    unmount()
    act(() => {
      vi.advanceTimersByTime(DELAY * 2)
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a delay that is not a non-negative finite number', () => {
    for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => renderHook(() => useDebouncedCallback(() => {}, delay))).toThrow(RangeError)
    }
  })

  it('collapses any burst of calls into exactly one run of the last (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 5000 }),
        (values, delayMs) => {
          const spy = vi.fn()
          const { result, unmount } = renderHook(() => useDebouncedCallback(spy, delayMs))
          act(() => {
            for (const value of values) result.current.call(value)
          })
          act(() => {
            vi.advanceTimersByTime(delayMs)
          })

          expect(spy).toHaveBeenCalledOnce()
          expect(spy).toHaveBeenCalledWith(values.at(-1))
          unmount()
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})
