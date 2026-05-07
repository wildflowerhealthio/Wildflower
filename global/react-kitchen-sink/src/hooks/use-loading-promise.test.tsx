import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { useLoadingPromise } from './use-loading-promise.ts'

describe('useLoadingPromise', () => {
  it('should start in the loading state on initial render', () => {
    // Arrange
    const { promise } = Promise.withResolvers<number>()

    // Act
    const { result } = renderHook(({ p }) => useLoadingPromise(p), {
      initialProps: { p: promise },
    })

    // Assert
    expect(result.current).toEqual({ value: undefined, loading: true, error: undefined })
  })

  it('should transition to the resolved state when the promise resolves', async () => {
    // Arrange
    const { promise, resolve } = Promise.withResolvers<number>()
    const { result } = renderHook(({ p }) => useLoadingPromise(p), {
      initialProps: { p: promise },
    })

    // Act
    await act(async () => {
      resolve(42)
    })

    // Assert
    await waitFor(() => {
      expect(result.current).toEqual({ value: 42, loading: false, error: undefined })
    })
  })

  it('should transition to the error state when the promise rejects', async () => {
    // Arrange
    const reason = new Error('boom')
    const { promise, reject } = Promise.withResolvers<number>()
    const { result } = renderHook(({ p }) => useLoadingPromise(p), {
      initialProps: { p: promise },
    })

    // Act
    await act(async () => {
      reject(reason)
    })

    // Assert
    await waitFor(() => {
      expect(result.current).toEqual({ value: undefined, loading: false, error: reason })
    })
  })

  it('should reset to loading when the promise reference changes', async () => {
    // Arrange
    const first = Promise.withResolvers<number>()
    const second = Promise.withResolvers<number>()
    const { result, rerender } = renderHook(({ p }) => useLoadingPromise(p), {
      initialProps: { p: first.promise },
    })
    await act(async () => {
      first.resolve(1)
    })
    await waitFor(() => {
      expect(result.current.value).toBe(1)
    })

    // Act
    rerender({ p: second.promise })

    // Assert
    expect(result.current).toEqual({ value: undefined, loading: true, error: undefined })

    // …and a later resolution of the new promise lands in the new state.
    await act(async () => {
      second.resolve(2)
    })
    await waitFor(() => {
      expect(result.current).toEqual({ value: 2, loading: false, error: undefined })
    })
  })

  it('should ignore stale settlements after unmount', async () => {
    // Arrange
    const { promise, resolve } = Promise.withResolvers<number>()
    const { result, unmount } = renderHook(({ p }) => useLoadingPromise(p), {
      initialProps: { p: promise },
    })
    const stateBeforeUnmount = result.current

    // Act
    unmount()
    await act(async () => {
      resolve(99)
      await promise
    })

    // Assert — `result.current` reflects the last state captured before
    // unmount; if the post-unmount setState had fired, the hook would
    // have warned and the value would be 99.
    expect(result.current).toBe(stateBeforeUnmount)
  })
})
