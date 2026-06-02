import { act, renderHook, waitFor } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { usePromiseOrDefault } from './use-promise-or-default.ts'

describe('usePromiseOrDefault', () => {
  it('should return whilePending until the promise resolves', () => {
    // Arrange
    const { promise } = Promise.withResolvers<number>()

    // Act
    const { result } = renderHook(({ p }) => usePromiseOrDefault(p, -1, () => -2), {
      initialProps: { p: promise },
    })

    // Assert
    expect(result.current).toBe(-1)
  })

  it('should return the resolved value once the promise settles', async () => {
    // Arrange
    const { promise, resolve } = Promise.withResolvers<number>()
    const { result } = renderHook(({ p }) => usePromiseOrDefault(p, -1, () => -2), {
      initialProps: { p: promise },
    })

    // Act
    await act(async () => {
      resolve(42)
    })

    // Assert
    await waitFor(() => {
      expect(result.current).toBe(42)
    })
  })

  it('should return onErr(err) when the promise rejects', async () => {
    // Arrange
    const reason = new Error('boom')
    const seenErrors: unknown[] = []
    const { promise, reject } = Promise.withResolvers<number>()
    const { result } = renderHook(
      ({ p }) =>
        usePromiseOrDefault(p, -1, (err) => {
          seenErrors.push(err)
          return -99
        }),
      { initialProps: { p: promise } }
    )

    // Act
    await act(async () => {
      reject(reason)
    })

    // Assert
    await waitFor(() => {
      expect(result.current).toBe(-99)
    })
    expect(seenErrors).toEqual([reason])
  })

  it('should reset to whilePending when the promise reference changes', async () => {
    // Arrange
    const first = Promise.withResolvers<number>()
    const second = Promise.withResolvers<number>()
    const { result, rerender } = renderHook(({ p }) => usePromiseOrDefault(p, -1, () => -2), {
      initialProps: { p: first.promise },
    })
    await act(async () => {
      first.resolve(1)
    })
    await waitFor(() => {
      expect(result.current).toBe(1)
    })

    // Act
    rerender({ p: second.promise })

    // Assert
    expect(result.current).toBe(-1)

    // …and a later resolution of the new promise lands in state.
    await act(async () => {
      second.resolve(2)
    })
    await waitFor(() => {
      expect(result.current).toBe(2)
    })
  })

  it('should ignore stale settlements after unmount', async () => {
    // Arrange
    const { promise, resolve } = Promise.withResolvers<number>()
    const { result, unmount } = renderHook(({ p }) => usePromiseOrDefault(p, -1, () => -2), {
      initialProps: { p: promise },
    })
    const valueBeforeUnmount = result.current

    // Act
    unmount()
    await act(async () => {
      resolve(99)
      await promise
    })

    // Assert — if the post-unmount setState had fired, result.current
    // would be 99.
    expect(result.current).toBe(valueBeforeUnmount)
  })

  it('should ignore a stale settlement after the tracked promise reference swaps mid-flight', async () => {
    // Arrange — render with A pending, rerender with B pending.
    const first = Promise.withResolvers<number>()
    const second = Promise.withResolvers<number>()
    const { result, rerender } = renderHook(({ p }) => usePromiseOrDefault(p, -1, () => -2), {
      initialProps: { p: first.promise },
    })
    rerender({ p: second.promise })
    expect(result.current).toBe(-1)

    // Act — resolve A *after* B has taken over. The first effect's
    // `isMounted` guard must have flipped during cleanup so A's
    // settlement is ignored.
    await act(async () => {
      first.resolve(42)
      await first.promise
    })

    // Assert — value stays at whilePending; A's resolution doesn't leak.
    expect(result.current).toBe(-1)

    // …and B's resolution lands as expected.
    await act(async () => {
      second.resolve(7)
    })
    await waitFor(() => {
      expect(result.current).toBe(7)
    })
  })

  it('property: final settled value matches the most-recently-passed promise resolution under any interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1–4 promises in the rerender sequence, each with a distinct
        // resolution value.
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 4 }),
        // Permutation over [0..n-1] — the order resolutions actually
        // arrive. Each `id` is a stable index into the rerender
        // sequence; the resolved value is the same `id` so we can
        // identify which promise the final state came from.
        async (resolutions) => {
          const n = resolutions.length
          const ids = Array.from({ length: n }, (_, i) => i)

          // Pre-shuffle resolution order with a deterministic permutation
          // derived from the property's own input — no extra arbitrary
          // needed; the inputs already vary enough across runs.
          const order: number[] = []
          const remaining = [...ids]
          for (const r of resolutions) {
            if (remaining.length === 0) break
            const idx = r % remaining.length
            const pickedArr = remaining.splice(idx, 1)
            const picked = pickedArr[0]
            if (picked === undefined) break
            order.push(picked)
          }
          // Append any IDs not yet drawn (when resolutions had duplicates).
          order.push(...remaining)

          const settlers = ids.map(() => Promise.withResolvers<number>())

          // Render with promise 0, then rerender through promises 1..n-1.
          // Final tracked promise reference is the *last* one — the hook
          // contract is that the final state matches that promise's
          // resolution.
          const { result, rerender } = renderHook(
            ({ p }: { p: Promise<number> }) => usePromiseOrDefault(p, -1, () => -2),
            { initialProps: { p: settlers[0]?.promise ?? Promise.resolve(-1) } }
          )
          for (let i = 1; i < n; i++) {
            const entry = settlers[i]
            if (entry === undefined) continue
            rerender({ p: entry.promise })
          }

          // Drive resolutions in the chosen order. Each settles with its
          // own id as the value (so a stale leak would be observable).
          for (const id of order) {
            const entry = settlers[id]
            if (entry === undefined) continue
            await act(async () => {
              entry.resolve(id)
              await entry.promise
            })
          }

          // The final state must match the *last-passed* promise's
          // resolution (id n - 1), regardless of resolution order.
          await waitFor(() => {
            expect(result.current).toBe(n - 1)
          })
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})
