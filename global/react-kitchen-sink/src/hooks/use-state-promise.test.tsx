import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { useStatePromise } from './use-state-promise.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useStatePromise', () => {
  it('should return a stable pending promise on initial render', () => {
    // Arrange
    // Act
    const { result, rerender } = renderHook(() => useStatePromise<number>())
    const [firstPromise] = result.current
    rerender()
    const [secondPromise] = result.current

    // Assert
    expect(secondPromise).toBe(firstPromise)
  })

  it('should resolve the promise with the value passed to resolve', async () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [promise, callbacks] = result.current

    // Act
    act(() => {
      callbacks.resolve(42)
    })

    // Assert
    await expect(promise).resolves.toBe(42)
  })

  it('should reject the promise with the reason passed to reject', async () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [promise, callbacks] = result.current
    const reason = new Error('boom')

    // Act
    act(() => {
      void callbacks.reject(reason)
    })

    // Assert
    await expect(promise).rejects.toBe(reason)
  })

  it('should apply a queued map atomically when resolve fires', async () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [promise, callbacks] = result.current

    // Act
    act(() => {
      callbacks.map((n) => n + 1)
      callbacks.map((n) => n * 10)
      callbacks.resolve(2)
    })

    // Assert — maps compose in registration order: (2 + 1) * 10
    await expect(promise).resolves.toBe(30)
  })

  it('should chain map onto a settled promise and replace its identity', async () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [initialPromise, callbacks] = result.current
    act(() => {
      callbacks.resolve(5)
    })
    await expect(initialPromise).resolves.toBe(5)

    // Act
    act(() => {
      callbacks.map((n) => n + 100)
    })
    const [mappedPromise] = result.current

    // Assert
    expect(mappedPromise).not.toBe(initialPromise)
    await expect(mappedPromise).resolves.toBe(105)
  })

  it('should replace a settled promise with a new resolved one when resolve is called again', async () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [firstPromise, callbacks] = result.current
    act(() => {
      callbacks.resolve(1)
    })
    await expect(firstPromise).resolves.toBe(1)

    // Act
    act(() => {
      callbacks.resolve(2)
    })
    const [secondPromise] = result.current

    // Assert
    expect(secondPromise).not.toBe(firstPromise)
    await expect(secondPromise).resolves.toBe(2)
  })

  it('should replace a settled promise with a fresh pending one on reset', async () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [firstPromise, callbacks] = result.current
    act(() => {
      callbacks.resolve(7)
    })
    await expect(firstPromise).resolves.toBe(7)

    // Act
    act(() => {
      callbacks.reset()
    })
    const [secondPromise, secondCallbacks] = result.current

    // Assert
    expect(secondPromise).not.toBe(firstPromise)
    act(() => {
      secondCallbacks.resolve(8)
    })
    await expect(secondPromise).resolves.toBe(8)
  })

  it('should be a no-op when reset is called on a still-pending promise', () => {
    // Arrange
    const { result } = renderHook(() => useStatePromise<number>())
    const [firstPromise, callbacks] = result.current

    // Act
    act(() => {
      callbacks.reset()
    })
    const [secondPromise] = result.current

    // Assert
    expect(secondPromise).toBe(firstPromise)
  })

  it('should keep the callbacks object identity stable across renders', () => {
    // Arrange
    const { result, rerender } = renderHook(() => useStatePromise<number>())
    const [, firstCallbacks] = result.current

    // Act
    rerender()
    const [, secondCallbacks] = result.current

    // Assert
    expect(secondCallbacks).toBe(firstCallbacks)
  })
})
