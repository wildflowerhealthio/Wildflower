import { renderHook, waitFor } from '@testing-library/react'
import { Context, Effect, Layer, ManagedRuntime, Stream } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { useStream } from './use-stream.ts'

describe('useStream', () => {
  it('should resolve the promise with the latest emitted value', async () => {
    // Arrange
    const stream = Stream.fromIterable([1, 2, 3])

    // Act
    const { result } = renderHook(() => useStream(stream))

    // Assert — each emit replaces the promise identity, so the
    // latest `result.current` resolves with the last value.
    await waitFor(async () => {
      await expect(result.current).resolves.toBe(3)
    })
  })

  it('should reject the promise with the failure value when the stream errors', async () => {
    // Arrange
    const error = new Error('stream broke')
    const stream = Stream.fail(error)

    // Act
    const { result } = renderHook(() => useStream(stream))

    // Assert
    await expect(result.current).rejects.toBe(error)
  })

  it('should not resolve when the stream completes without emitting any value', async () => {
    // Arrange
    const stream = Stream.empty
    const { result } = renderHook(() => useStream(stream))
    const promise = result.current

    // Act
    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Assert
    expect(settled).toBe(false)
  })

  it('should accept a ManagedRuntime providing the stream context', async () => {
    // Arrange
    class Source extends Context.Tag('Source')<Source, { readonly value: number }>() {}
    const layer = Layer.succeed(Source, { value: 7 })
    const runtime = ManagedRuntime.make(layer)
    const stream = Stream.fromEffect(
      Effect.gen(function* () {
        const s = yield* Source
        return s.value
      })
    )

    // Act
    const { result } = renderHook(() => useStream(stream, runtime))

    // Assert
    await expect(result.current).resolves.toBe(7)
    await runtime.dispose()
  })
})
