import { renderHook } from '@testing-library/react'
import { Effect, ManagedRuntime, Layer, Context, Cause } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { useEffectTs } from './use-effect-ts.ts'

describe('useEffectTs', () => {
  it('should resolve the promise with the value when the effect succeeds', async () => {
    // Arrange
    const effect = Effect.succeed(42)

    // Act
    const { result } = renderHook(() => useEffectTs(effect))

    // Assert
    await expect(result.current).resolves.toBe(42)
  })

  it('should reject the promise with the failure value when the effect fails', async () => {
    // Arrange
    const error = new Error('boom')
    const effect = Effect.fail(error)

    // Act
    const { result } = renderHook(() => useEffectTs(effect))

    // Assert
    await expect(result.current).rejects.toBe(error)
  })

  it('should reject with AggregateError when the effect produces multiple failures', async () => {
    // Arrange
    const effect = Effect.all([Effect.fail(new Error('first')), Effect.fail(new Error('second'))], {
      concurrency: 'unbounded',
      mode: 'either',
    }).pipe(
      Effect.flatMap(() =>
        Effect.failCause(Cause.parallel(Cause.fail(new Error('a')), Cause.fail(new Error('b'))))
      )
    )

    // Act
    const { result } = renderHook(() => useEffectTs(effect))

    // Assert
    const rejection: unknown = await result.current.then(
      () => {
        throw new Error('expected rejection')
      },
      (e: unknown) => e
    )
    if (!(rejection instanceof AggregateError)) {
      throw new Error('expected an AggregateError rejection')
    }
    expect(rejection.errors).toHaveLength(2)
  })

  it('should not reject when the effect is interrupted via component unmount', async () => {
    // Arrange — an effect that never settles on its own.
    const neverSettles = Effect.never
    const { result, unmount } = renderHook(() => useEffectTs(neverSettles))
    const promise = result.current
    let rejected: unknown = null
    void promise.catch((e: unknown) => {
      rejected = e
    })

    // Act
    unmount()
    // Yield enough microtasks for any rejection to surface.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Assert — interruption is silently swallowed.
    expect(rejected).toBeNull()
  })

  it('should accept a ManagedRuntime providing the effect context', async () => {
    // Arrange
    class Greeter extends Context.Tag('Greeter')<Greeter, { readonly hi: string }>() {}
    const layer = Layer.succeed(Greeter, { hi: 'hello' })
    const runtime = ManagedRuntime.make(layer)
    const effect = Effect.gen(function* () {
      const g = yield* Greeter
      return g.hi
    })

    // Act
    const { result } = renderHook(() => useEffectTs(effect, runtime))

    // Assert
    await expect(result.current).resolves.toBe('hello')
    await runtime.dispose()
  })
})
