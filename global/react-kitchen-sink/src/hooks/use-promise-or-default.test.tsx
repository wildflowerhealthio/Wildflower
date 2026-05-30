import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { usePromiseOrDefault } from './use-promise-or-default.ts'

describe('usePromiseOrDefault', () => {
  it('should return whilePending until the promise resolves', () => {
    // Arrange
    const { promise } = Promise.withResolvers<number>()

    // Act
    const { result } = renderHook(
      ({ p }) =>
        usePromiseOrDefault(p, -1, () => -2),
      { initialProps: { p: promise } }
    )

    // Assert
    expect(result.current).toBe(-1)
  })

  it('should return the resolved value once the promise settles', async () => {
    // Arrange
    const { promise, resolve } = Promise.withResolvers<number>()
    const { result } = renderHook(
      ({ p }) =>
        usePromiseOrDefault(p, -1, () => -2),
      { initialProps: { p: promise } }
    )

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
    const { result, rerender } = renderHook(
      ({ p }) =>
        usePromiseOrDefault(p, -1, () => -2),
      { initialProps: { p: first.promise } }
    )
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
    const { result, unmount } = renderHook(
      ({ p }) =>
        usePromiseOrDefault(p, -1, () => -2),
      { initialProps: { p: promise } }
    )
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
})
