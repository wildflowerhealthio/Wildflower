import { render, renderHook } from '@testing-library/react'
import { type JSX, memo, useState } from 'react'
import { describe, expect, test } from 'vite-plus/test'

import { usePreviousDistinctValue } from './use-previous-distinct-value.ts'

describe('usePreviousDistinctValue', () => {
  test('returns the initial value on the first render (no false-fire on mount)', () => {
    const { result } = renderHook(() => usePreviousDistinctValue('a'))
    expect(result.current).toBe('a')
  })

  test('committed return equals current on a stable render (no fire when nothing changed)', () => {
    const { result, rerender } = renderHook(
      ({ v }: { readonly v: string }) => usePreviousDistinctValue(v),
      { initialProps: { v: 'a' } }
    )
    expect(result.current).toBe('a')

    // Rendering with the same value must leave the committed return equal to
    // it — otherwise the caller's `value !== hook` comparison would false-fire.
    rerender({ v: 'a' })
    expect(result.current).toBe('a')

    rerender({ v: 'a' })
    expect(result.current).toBe('a')
  })

  test('committed return catches up to `value` by the render that commits (no fire beyond the change render)', () => {
    const { result, rerender } = renderHook(
      ({ v }: { readonly v: string }) => usePreviousDistinctValue(v),
      { initialProps: { v: 'a' } }
    )
    expect(result.current).toBe('a')

    // After a change, the *committed* render (pass 2) returns the new value —
    // so a subsequent render with the same value can't false-fire. The old
    // value is briefly returned during pass 1 of the transition; the fires-
    // exactly-once test below observes that indirectly.
    rerender({ v: 'b' })
    expect(result.current).toBe('b')

    rerender({ v: 'b' })
    expect(result.current).toBe('b')

    rerender({ v: 'c' })
    expect(result.current).toBe('c')
  })

  test('caller pattern `value !== hook(value)` fires exactly once per transition', () => {
    // The whole reason the hook exists is to run a same-tick side effect
    // exactly once per transition. Model that: count how many times a memo'd
    // component sees value !== hook. renderHook's own result would only ever
    // observe the committed pass, missing this — assert on the count.
    let fires = 0
    const Observer = memo(({ v }: { readonly v: string }): null => {
      const prev = usePreviousDistinctValue(v)
      if (v !== prev) fires += 1
      return null
    })
    Observer.displayName = 'Observer'

    const { rerender } = render(<Observer v="a" />)
    expect(fires).toBe(0)

    rerender(<Observer v="a" />)
    expect(fires).toBe(0)

    rerender(<Observer v="b" />)
    expect(fires).toBe(1)

    // Same value → no additional fire (the bug this test guards against was
    // a hook that kept returning the OLD value forever after a change, making
    // the caller's if fire on every subsequent render).
    rerender(<Observer v="b" />)
    expect(fires).toBe(1)

    rerender(<Observer v="b" />)
    expect(fires).toBe(1)

    rerender(<Observer v="c" />)
    expect(fires).toBe(2)

    rerender(<Observer v="c" />)
    expect(fires).toBe(2)
  })

  test("stable value across a parent's own state churn doesn't fire (fresh-render but same-input)", () => {
    // A stable prop across a parent that re-renders many times must not
    // trigger the change signal. A hook that watched *render identity*
    // instead of *value identity* would fire on every re-render.
    let fires = 0
    const Observer = memo(({ v }: { readonly v: number }): null => {
      const prev = usePreviousDistinctValue(v)
      if (v !== prev) fires += 1
      return null
    })
    Observer.displayName = 'Observer'

    function Parent(): JSX.Element {
      const [tick, setTick] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setTick(tick + 1)}>
            {tick}
          </button>
          <Observer v={42} />
        </>
      )
    }

    const { getByRole } = render(<Parent />)
    expect(fires).toBe(0)

    // Force a bunch of parent renders without changing v — memo passes v=42
    // through with the same identity each time.
    for (let i = 0; i < 5; i++) {
      getByRole('button').click()
    }
    expect(fires).toBe(0)
  })

  test('compares with Object.is (NaN-to-NaN is not a change; 0 to -0 is)', () => {
    let fires = 0
    const Observer = memo(({ v }: { readonly v: number }): null => {
      const prev = usePreviousDistinctValue(v)
      if (!Object.is(v, prev)) fires += 1
      return null
    })
    Observer.displayName = 'Observer'

    const { rerender } = render(<Observer v={Number.NaN} />)
    expect(fires).toBe(0)

    // NaN to NaN — Object.is says equal, so no fire.
    rerender(<Observer v={Number.NaN} />)
    expect(fires).toBe(0)

    // NaN to 0 — a real transition, one fire.
    rerender(<Observer v={0} />)
    expect(fires).toBe(1)

    // 0 to -0 — Object.is says NOT equal, unlike ===, so this fires.
    rerender(<Observer v={-0} />)
    expect(fires).toBe(2)
  })

  test('reference identity: same reference no fire, different reference does', () => {
    const a = { id: 'a' }
    const aClone = { id: 'a' }

    let fires = 0
    const Observer = memo(({ v }: { readonly v: { readonly id: string } }): null => {
      const prev = usePreviousDistinctValue(v)
      if (v !== prev) fires += 1
      return null
    })
    Observer.displayName = 'Observer'

    const { rerender } = render(<Observer v={a} />)
    expect(fires).toBe(0)

    // Same reference — no fire.
    rerender(<Observer v={a} />)
    expect(fires).toBe(0)

    // Structurally equal, distinct reference — Object.is treats as changed.
    rerender(<Observer v={aClone} />)
    expect(fires).toBe(1)

    rerender(<Observer v={aClone} />)
    expect(fires).toBe(1)
  })
})
