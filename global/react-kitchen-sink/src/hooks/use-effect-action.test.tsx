import { renderHook, waitFor } from '@testing-library/react'
import { Context, Effect, Layer, Ref } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { useEffectAction } from './use-effect-action.ts'

describe('useEffectAction', () => {
  it('should resolve the returned promise with the success value', async () => {
    // Arrange
    const layer = Layer.empty
    const { result } = renderHook(() => useEffectAction(layer))

    // Act
    const promise = result.current(Effect.succeed(42))

    // Assert
    await expect(promise).resolves.toBe(42)
  })

  it('should reject with the failure value on a single failure', async () => {
    // Arrange
    const error = new Error('boom')
    const layer = Layer.empty
    const { result } = renderHook(() => useEffectAction(layer))

    // Act
    const promise = result.current(Effect.fail(error))

    // Assert
    await expect(promise).rejects.toBe(error)
  })

  it('should release the effect scope when the returned promise settles', async () => {
    // Arrange — a sentinel ref toggled by an acquire/release pair lets
    // us observe whether the transient scope opened by the runner has
    // closed by the time the consumer awaits the result.
    const released: { value: boolean } = { value: false }
    const layer = Layer.empty
    const { result } = renderHook(() => useEffectAction(layer))

    // Act
    const value = await result.current(
      Effect.acquireRelease(Effect.succeed('acquired'), () =>
        Effect.sync(() => {
          released.value = true
        })
      ).pipe(Effect.flatMap((a) => Effect.succeed(a)))
    )

    // Assert
    expect(value).toBe('acquired')
    expect(released.value).toBe(true)
  })

  it('should return a stable runner identity across renders with the same layer', () => {
    // Arrange
    const layer = Layer.empty

    // Act
    const { result, rerender } = renderHook(({ l }) => useEffectAction(l), {
      initialProps: { l: layer },
    })
    const first = result.current
    rerender({ l: layer })
    const second = result.current

    // Assert — identity is preserved so downstream hook deps stay sound.
    expect(second).toBe(first)
  })

  it('should produce a new runner when the layer reference changes', () => {
    // Arrange
    const layerA = Layer.empty
    const layerB = Layer.empty
    const { result, rerender } = renderHook(({ l }) => useEffectAction(l), {
      initialProps: { l: layerA },
    })
    const first = result.current

    // Act
    rerender({ l: layerB })
    const second = result.current

    // Assert
    expect(second).not.toBe(first)
  })

  it('should accept context from the supplied layer', async () => {
    // Arrange
    class Greeter extends Context.Tag('Greeter')<Greeter, { readonly hi: string }>() {}
    const layer = Layer.succeed(Greeter, { hi: 'hello' })
    const { result } = renderHook(() => useEffectAction(layer))

    // Act
    const value = await result.current(Effect.flatMap(Greeter, (g) => Effect.succeed(g.hi)))

    // Assert
    expect(value).toBe('hello')
  })

  describe('with { interruptOnUnmount: true }', () => {
    it('should resolve the returned promise with the success value', async () => {
      // Arrange
      const layer = Layer.empty
      const { result } = renderHook(() => useEffectAction(layer, { interruptOnUnmount: true }))

      // Act
      const promise = result.current(Effect.succeed(42))

      // Assert
      await expect(promise).resolves.toBe(42)
    })

    it('should reject with the failure value on a single failure', async () => {
      // Arrange
      const error = new Error('boom')
      const layer = Layer.empty
      const { result } = renderHook(() => useEffectAction(layer, { interruptOnUnmount: true }))

      // Act
      const promise = result.current(Effect.fail(error))

      // Assert
      await expect(promise).rejects.toBe(error)
    })

    it('should release the scope when the returned promise settles', async () => {
      // Arrange
      const released: { value: boolean } = { value: false }
      const layer = Layer.empty
      const { result } = renderHook(() => useEffectAction(layer, { interruptOnUnmount: true }))

      // Act
      const value = await result.current(
        Effect.acquireRelease(Effect.succeed('acquired'), () =>
          Effect.sync(() => {
            released.value = true
          })
        ).pipe(Effect.flatMap((a) => Effect.succeed(a)))
      )

      // Assert
      expect(value).toBe('acquired')
      expect(released.value).toBe(true)
    })

    it('should interrupt outstanding fibers when the host component unmounts', async () => {
      // Arrange — a `Ref` lets the test effect observe its own finaliser
      // running; `Effect.never` keeps the fiber alive until interrupted.
      const program = Effect.runSync(
        Effect.gen(function* () {
          const finalised = yield* Ref.make(false)
          const effect = Effect.acquireRelease(Effect.void, () => Ref.set(finalised, true)).pipe(
            Effect.flatMap(() => Effect.never)
          )
          return { finalised, effect }
        })
      )

      const layer = Layer.empty
      const { result, unmount } = renderHook(() =>
        useEffectAction(layer, { interruptOnUnmount: true })
      )

      // Act
      const pending = result.current(program.effect)
      // Swallow any rejection — interruption may surface as a rejected
      // promise depending on timing, and the test only cares about the
      // finaliser running.
      void pending.catch(() => undefined)
      unmount()

      // Assert — wait for the finaliser to flip the sentinel.
      await waitFor(async () => {
        const released = await Effect.runPromise(Ref.get(program.finalised))
        expect(released).toBe(true)
      })
    })

    it('should return a stable runner identity across renders with the same layer', () => {
      // Arrange
      const layer = Layer.empty

      // Act
      const { result, rerender } = renderHook(
        ({ l }) => useEffectAction(l, { interruptOnUnmount: true }),
        { initialProps: { l: layer } }
      )
      const first = result.current
      rerender({ l: layer })
      const second = result.current

      // Assert
      expect(second).toBe(first)
    })
  })
})
