import { isRedirect } from '@tanstack/react-router'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  AuthedUntil,
  type AuthState,
  HostAuthed,
  isAuthed,
  Unauthed,
} from '@wildflowerhealthio/react-kitchen-sink'
import { Effect, Either, SubscriptionRef } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { landingAuthReadyEffect } from './auth-ready.ts'

/**
 * Pins the `awaitAuthReady` core the launcher threads into the router
 * context: a synchronous authed/unauthed decision keyed purely on the
 * {@link AuthState} tag (`isAuthed`).
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
