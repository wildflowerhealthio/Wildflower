import { QueryClient } from '@tanstack/react-query'
import { Deferred, Effect, Fiber, SubscriptionRef } from 'effect'
import {
  AuthedUntil,
  type AuthSignal,
  type AuthTokenStore,
  HostAuthed,
  Unauthed,
} from 'react-kitchen-sink'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { forkTokenRotationInvalidator } from './app-root.tsx'

/**
 * Pins the token-rotation cache-flush contract that
 * {@link forkTokenRotationInvalidator} encodes via `Stream.drop(1)` on
 * `tokenStore.subscribable.changes`:
 *
 *  1. The replayed initial `SubscriptionRef` value is dropped, so a
 *     fresh subscribe does NOT flush the cache at boot (flushing before
 *     anything is cached is wasted work).
 *  2. Every *post-mount* `setSignal(...)` rotation flushes the cache
 *     exactly once, so 401-pinned entries from the previous bearer
 *     refetch under the new one.
 *
 * The helper was extracted from `renderApp` (which builds its own
 * `QueryClient`) precisely so this contract is testable against a real
 * `Subscribable`-backed store and a spy-able `QueryClient` without
 * mounting the whole app.
 */

/**
 * Build an in-memory {@link AuthTokenStore} matching
 * `gatekeeper-react`'s `makeEmbeddedAuthTokenStore` shape: a
 * `SubscriptionRef<AuthSignal>` seeded `Unauthed` plus a synchronous setter
 * that writes through it. The invalidator is forked against
 * `store.subscribable` — the same read surface the production wiring
 * (`renderApp`) passes in.
 */
const makeInMemoryTokenStore = (): AuthTokenStore => {
  const ref = Effect.runSync(SubscriptionRef.make<AuthSignal>(Unauthed()))
  return {
    subscribable: ref,
    setSignal: (signal) => Effect.runSync(SubscriptionRef.set(ref, signal)),
  }
}

describe('forkTokenRotationInvalidator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('does not flush the cache on the initial subscribe (Stream.drop(1) skips the replayed value)', async () => {
    const tokenStore = makeInMemoryTokenStore()
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)

    const fiber = forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

    // Yield the runtime enough turns for the forked fiber to subscribe
    // and process the replayed initial `Unauthed` value. `Effect.yieldNow`
    // hands control back to the scheduler, draining any work the fiber
    // has queued — no arbitrary wall-clock sleep.
    await Effect.runPromise(Effect.repeatN(Effect.yieldNow(), 10))

    expect(invalidateSpy).not.toHaveBeenCalled()

    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  test('flushes the cache exactly once per post-mount rotation', async () => {
    const tokenStore = makeInMemoryTokenStore()
    const queryClient = new QueryClient()

    // Resolve a Deferred from inside the spy so the test can await the
    // rotation propagating through the forked fiber deterministically,
    // rather than polling or sleeping.
    const flushed = Effect.runSync(Deferred.make<void>())
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(() => {
      Effect.runSync(Deferred.succeed(flushed, undefined))
      return Promise.resolve()
    })

    const fiber = forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

    // Let the forked fiber subscribe to `changes` and consume (drop)
    // the replayed initial `Unauthed` before we rotate — otherwise the
    // rotation would be the value the late subscriber replays-and-drops.
    await Effect.runPromise(Effect.repeatN(Effect.yieldNow(), 10))

    // Post-mount rotation: the host pushes a fresh signal.
    tokenStore.setSignal(HostAuthed())

    // Block until the forked fiber has actually run the invalidation.
    await Effect.runPromise(Deferred.await(flushed))

    // The boot value was dropped, so exactly one flush — the rotation.
    expect(invalidateSpy).toHaveBeenCalledTimes(1)

    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  test('flushes once per rotation across multiple rotations (boot value never counted)', async () => {
    const tokenStore = makeInMemoryTokenStore()
    const queryClient = new QueryClient()

    // Deferred per expected flush; the spy resolves them in order so the
    // test can await each rotation landing before triggering the next.
    const flushes = [Effect.runSync(Deferred.make<void>()), Effect.runSync(Deferred.make<void>())]
    let flushCount = 0
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(() => {
      const deferred = flushes[flushCount]
      flushCount += 1
      if (deferred !== undefined) Effect.runSync(Deferred.succeed(deferred, undefined))
      return Promise.resolve()
    })

    const fiber = forkTokenRotationInvalidator(tokenStore.subscribable, queryClient)

    // Let the fiber subscribe and drop the replayed initial `Unauthed`
    // before the first rotation (see the single-rotation test).
    await Effect.runPromise(Effect.repeatN(Effect.yieldNow(), 10))

    // Two *distinct* signals so each is a real change on `.changes`.
    tokenStore.setSignal(AuthedUntil({ exp: 1000 }))
    await Effect.runPromise(Deferred.await(flushes[0]))
    expect(invalidateSpy).toHaveBeenCalledTimes(1)

    tokenStore.setSignal(AuthedUntil({ exp: 2000 }))
    await Effect.runPromise(Deferred.await(flushes[1]))
    expect(invalidateSpy).toHaveBeenCalledTimes(2)

    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})
