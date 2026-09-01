import { renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { useLastRendersValue } from './use-last-renders-value.ts'

describe('useLastRendersValue', () => {
  test('returns the initial value on the first render', () => {
    const { result } = renderHook(() => useLastRendersValue('a'))
    expect(result.current).toBe('a')
  })

  test('returns the previous value across renders where the input changed', () => {
    const { result, rerender } = renderHook(
      ({ v }: { readonly v: string }) => useLastRendersValue(v),
      {
        initialProps: { v: 'a' },
      }
    )
    // First render: initial === current, previous returned as initial.
    expect(result.current).toBe('a')

    rerender({ v: 'b' })
    // Change committed under React's "adjust state while rendering" recipe;
    // the caller sees the prior render's value.
    expect(result.current).toBe('a')

    rerender({ v: 'c' })
    expect(result.current).toBe('b')

    rerender({ v: 'd' })
    expect(result.current).toBe('c')
  })

  test('leaves the returned value untouched across identical-value renders', () => {
    const { result, rerender } = renderHook(
      ({ v }: { readonly v: string }) => useLastRendersValue(v),
      {
        initialProps: { v: 'a' },
      }
    )
    expect(result.current).toBe('a')

    // Rendering with the same value doesn't advance "previous" — that's the
    // whole point of the semantics: the hook remembers the last render in
    // which the value differed, not literally the last committed render.
    rerender({ v: 'a' })
    expect(result.current).toBe('a')

    rerender({ v: 'a' })
    expect(result.current).toBe('a')

    rerender({ v: 'b' })
    expect(result.current).toBe('a')

    rerender({ v: 'b' })
    expect(result.current).toBe('a')
  })

  test('compares with Object.is (NaN equals NaN, -0 differs from 0)', () => {
    const { result, rerender } = renderHook(
      ({ v }: { readonly v: number }) => useLastRendersValue(v),
      {
        initialProps: { v: Number.NaN },
      }
    )
    expect(Number.isNaN(result.current)).toBe(true)

    rerender({ v: Number.NaN })
    // NaN-to-NaN is not a change under Object.is, so previous is unchanged.
    expect(Number.isNaN(result.current)).toBe(true)

    rerender({ v: 0 })
    // First change: previous returns the initial value.
    expect(Number.isNaN(result.current)).toBe(true)

    rerender({ v: -0 })
    // 0 vs -0 IS a change under Object.is (unlike ===).
    expect(result.current).toBe(0)
  })

  test('handles reference-typed values by identity', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const aClone = { id: 'a' }
    const { result, rerender } = renderHook(
      ({ v }: { readonly v: { readonly id: string } }) => useLastRendersValue(v),
      { initialProps: { v: a } }
    )
    expect(result.current).toBe(a)

    // Same reference — no change, previous unchanged.
    rerender({ v: a })
    expect(result.current).toBe(a)

    // Structurally equal but different identity — Object.is treats as changed.
    rerender({ v: aClone })
    expect(result.current).toBe(a)

    rerender({ v: b })
    expect(result.current).toBe(aClone)
  })
})
