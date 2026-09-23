import { isRedirect } from '@tanstack/react-router'
import { Duration, Effect, Either, Fiber, SubscriptionRef, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { AuthedUntil, type AuthState, HostAuthed, isAuthed, Unauthed } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import {
  EMBEDDED_TOKEN_TIMEOUT,
  embeddedAuthReadyEffect,
  landingAuthReadyEffect,
  TokenTimeout,
} from './auth-ready.ts'

/**
 * Pins the injected `awaitAuthReady` cores the entries thread into the
 * router context. The landing gate is a synchronous authed/unauthed
 * decision; embedded waits the host handshake up to `EMBEDDED_TOKEN_TIMEOUT`
 * and is driven here with `TestClock` so the 5s window is exercised without
 * real time.
 *
 * Both gates key purely on the {@link AuthState} tag (`isAuthed`).
 */

const makeRef = (initial: AuthState): Effect.Effect<SubscriptionRef.SubscriptionRef<AuthState>> =>
  SubscriptionRef.make<AuthState>(initial)

describe('landingAuthReadyEffect', () => {
  test('keeps the search the reader was on, so ?server= survives the bounce', async () => {
    const returnTo = '/home?server=https%3A%2F%2Fx.test'
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(Unauthed()), (ref) =>
        Effect.either(landingAuthReadyEffect(ref, returnTo))
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(isRedirect(result.left)).toBe(true)
      if (isRedirect(result.left)) {
        expect(result.left.options.to).toBe('/')
        // An updater, not a replacement: `main-web`'s `?server=` is the one
        // thing the landing page needs to offer a way back in, and a plain
        // object here would drop it on every reload-induced bounce.
        const search = result.left.options.search
        expect(typeof search).toBe('function')
        if (typeof search === 'function') {
          expect(search({ server: 'https://x.test' })).toStrictEqual({
            server: 'https://x.test',
            returnTo,
          })
        }
      }
    }
  })

  test('omits returnTo entirely when the gate supplies none', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(Unauthed()), (ref) => Effect.either(landingAuthReadyEffect(ref)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result) && isRedirect(result.left)) {
      const search = result.left.options.search
      expect(typeof search).toBe('function')
      if (typeof search === 'function') {
        expect(search({ server: 'https://x.test' })).toStrictEqual({ server: 'https://x.test' })
      }
    }
  })

  test('resolves without redirecting when the signal is authed', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(AuthedUntil({ exp: 9_999_999_999 })), (ref) =>
        Effect.either(landingAuthReadyEffect(ref))
      )
    )

    expect(result).toStrictEqual(Either.void)
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
          Effect.flatMap(makeRef(signal), (ref) => Effect.either(landingAuthReadyEffect(ref)))
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
