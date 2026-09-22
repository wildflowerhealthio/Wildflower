import { isRedirect } from '@tanstack/react-router'
import { Duration, Effect, Either, Fiber, SubscriptionRef, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { AuthedUntil, type AuthState, HostAuthed, isAuthed, Unauthed } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import {
  deviceLoginAuthReadyEffect,
  EMBEDDED_TOKEN_TIMEOUT,
  embeddedAuthReadyEffect,
  TokenTimeout,
} from './auth-ready.ts'

/**
 * Pins the injected `awaitAuthReady` cores the entries thread into the
 * router context. The device-login gate is a synchronous authed/unauthed
 * decision; embedded waits the host handshake up to `EMBEDDED_TOKEN_TIMEOUT`
 * and is driven here with `TestClock` so the 5s window is exercised without
 * real time.
 *
 * The gate keys purely on the {@link AuthState} tag (`isAuthed`); the
 * cookie-expiry logic that turns a stale hint into `Unauthed` lives in
 * `auth-state-store`'s `readAuthedSignalFromCookie` and is pinned there.
 */

const makeRef = (initial: AuthState): Effect.Effect<SubscriptionRef.SubscriptionRef<AuthState>> =>
  SubscriptionRef.make<AuthState>(initial)

describe('deviceLoginAuthReadyEffect', () => {
  test('resolves when the signal is authed (standalone web)', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(AuthedUntil({ exp: 9_999_999_999 })), (ref) =>
        Effect.either(deviceLoginAuthReadyEffect(ref))
      )
    )

    expect(result).toStrictEqual(Either.void)
  })

  test('rejects with a TanStack redirect to the device-login route when unauthed', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(Unauthed()), (ref) => Effect.either(deviceLoginAuthReadyEffect(ref)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(isRedirect(result.left)).toBe(true)
      if (isRedirect(result.left)) {
        expect(result.left.options.to).toBe('/gatekeeper/device-login')
        // Omitting returnTo still emits a well-formed search whose
        // returnTo reads as absent, so the consumer falls back to its
        // default destination rather than seeing a stray value.
        expect(result.left.options.search).toStrictEqual({ returnTo: undefined })
      }
    }
  })

  test('bakes the supplied returnTo into the redirect search', async () => {
    const returnTo = '/home?tab=labs'
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(Unauthed()), (ref) =>
        Effect.either(deviceLoginAuthReadyEffect(ref, returnTo))
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(isRedirect(result.left)).toBe(true)
      if (isRedirect(result.left)) {
        expect(result.left.options.to).toBe('/gatekeeper/device-login')
        // The originally-requested path rides the redirect verbatim so
        // `NeedsAuthMessage` can return the user there post-sign-in.
        expect(result.left.options.search).toStrictEqual({ returnTo })
      }
    }
  })

  test('Right ↔ authed signal (property)', async () => {
    // Pins the gate's truth-table: a `Right` corresponds exactly to a
    // non-`Unauthed` signal, across every `AuthState` variant.
    const anySignal: fc.Arbitrary<AuthState> = fc.oneof(
      fc.constant(Unauthed()),
      fc.constant(HostAuthed()),
      fc.integer().map((exp) => AuthedUntil({ exp }))
    )
    await fc.assert(
      fc.asyncProperty(anySignal, async (signal) => {
        const result = await Effect.runPromise(
          Effect.flatMap(makeRef(signal), (ref) => Effect.either(deviceLoginAuthReadyEffect(ref)))
        )
        expect(Either.isRight(result)).toBe(isAuthed(signal))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('embeddedAuthReadyEffect', () => {
  test('resolves immediately when the signal already landed authed', async () => {
    const program = Effect.gen(function* () {
      const ref = yield* makeRef(HostAuthed())
      return yield* Effect.either(embeddedAuthReadyEffect(ref))
    }).pipe(Effect.provide(TestContext.TestContext))

    const result = await Effect.runPromise(program)
    expect(result).toStrictEqual(Either.void)
  })

  test('resolves once the host flips the signal within the window', async () => {
    const program = Effect.gen(function* () {
      const ref = yield* makeRef(Unauthed())
      const fiber = yield* Effect.fork(Effect.either(embeddedAuthReadyEffect(ref)))
      // Advance partway, then the host flips the signal (bridge write).
      yield* TestClock.adjust(Duration.seconds(2))
      yield* SubscriptionRef.set(ref, HostAuthed())
      yield* TestClock.adjust(Duration.seconds(1))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))

    const result = await Effect.runPromise(program)
    expect(result).toStrictEqual(Either.void)
  })

  test('rejects with TokenTimeout when the window elapses still unauthed', async () => {
    const program = Effect.gen(function* () {
      const ref = yield* makeRef(Unauthed())
      const fiber = yield* Effect.fork(Effect.either(embeddedAuthReadyEffect(ref)))
      // Push past the full timeout without ever flipping the signal.
      yield* TestClock.adjust(Duration.sum(EMBEDDED_TOKEN_TIMEOUT, Duration.seconds(1)))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))

    const result = await Effect.runPromise(program)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(TokenTimeout)
  })
})
