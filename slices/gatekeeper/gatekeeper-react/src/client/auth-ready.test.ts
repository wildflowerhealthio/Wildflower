import { isRedirect } from '@tanstack/react-router'
import {
  Cause,
  Duration,
  Effect,
  Either,
  Fiber,
  Runtime,
  SubscriptionRef,
  TestClock,
  TestContext,
} from 'effect'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  EMBEDDED_TOKEN_TIMEOUT,
  embeddedAuthReadyEffect,
  TokenTimeout,
  unwrapFiberFailure,
  webAuthReadyEffect,
} from './auth-ready.ts'

/**
 * Pins the injected `awaitAuthReady` cores the entries thread into the
 * router context. Web is a synchronous present/absent decision; embedded
 * waits the host handshake up to `EMBEDDED_TOKEN_TIMEOUT` and is driven
 * here with `TestClock` so the 5s window is exercised without real time.
 */

const makeRef = (
  initial: string | null
): Effect.Effect<SubscriptionRef.SubscriptionRef<string | null>> =>
  SubscriptionRef.make<string | null>(initial)

describe('webAuthReadyEffect', () => {
  test('resolves when a token is already present (standalone web)', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef('a-token'), (ref) => Effect.either(webAuthReadyEffect(ref)))
    )

    expect(result).toStrictEqual(Either.void)
  })

  test('rejects with a TanStack redirect to the device-login route when no token is present', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(null), (ref) => Effect.either(webAuthReadyEffect(ref)))
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
      Effect.flatMap(makeRef(null), (ref) => Effect.either(webAuthReadyEffect(ref, returnTo)))
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

  test('treats the empty string as absent (rejects with a redirect)', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(''), (ref) => Effect.either(webAuthReadyEffect(ref)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(isRedirect(result.left)).toBe(true)
  })

  test('Right ↔ present-and-non-empty token (property)', async () => {
    // Pins the truth-table for `isPresent`: a `Right` corresponds
    // exactly to a non-null, non-empty token. `fc.string()` includes
    // the empty string, so this also covers the empty-string-as-absent
    // case across the rest of the input space.
    await fc.assert(
      fc.asyncProperty(fc.option(fc.string(), { nil: null }), async (token) => {
        const result = await Effect.runPromise(
          Effect.flatMap(makeRef(token), (ref) => Effect.either(webAuthReadyEffect(ref)))
        )
        expect(Either.isRight(result)).toBe(token !== null && token !== '')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('embeddedAuthReadyEffect', () => {
  test('resolves immediately when a token already landed', async () => {
    const program = Effect.gen(function* () {
      const ref = yield* makeRef('host-token')
      return yield* Effect.either(embeddedAuthReadyEffect(ref))
    }).pipe(Effect.provide(TestContext.TestContext))

    const result = await Effect.runPromise(program)
    expect(result).toStrictEqual(Either.void)
  })

  test('resolves once the host delivers the token within the window', async () => {
    const program = Effect.gen(function* () {
      const ref = yield* makeRef(null)
      const fiber = yield* Effect.fork(Effect.either(embeddedAuthReadyEffect(ref)))
      // Advance partway, then the host delivers the token (bridge write).
      yield* TestClock.adjust(Duration.seconds(2))
      yield* SubscriptionRef.set(ref, 'delivered')
      yield* TestClock.adjust(Duration.seconds(1))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))

    const result = await Effect.runPromise(program)
    expect(result).toStrictEqual(Either.void)
  })

  test('rejects with TokenTimeout when the window elapses with no token', async () => {
    const program = Effect.gen(function* () {
      const ref = yield* makeRef(null)
      const fiber = yield* Effect.fork(Effect.either(embeddedAuthReadyEffect(ref)))
      // Push past the full timeout without ever delivering a token.
      yield* TestClock.adjust(Duration.sum(EMBEDDED_TOKEN_TIMEOUT, Duration.seconds(1)))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))

    const result = await Effect.runPromise(program)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(TokenTimeout)
  })
})

describe('unwrapFiberFailure', () => {
  test('returns the underlying value when given a FiberFailure wrapping a failure-channel TokenTimeout', () => {
    // Some Effect pipelines route a typed failure through the Cause
    // layer (Stream operators, scope-interrupt chains) and emerge as a
    // FiberFailure rather than the bare typed value. Construct that
    // shape directly: a FiberFailure whose cause is `Cause.fail(...)`.
    const tokenTimeout = new TokenTimeout({})
    const wrapped = Runtime.makeFiberFailure(Cause.fail(tokenTimeout))

    expect(unwrapFiberFailure(wrapped)).toBe(tokenTimeout)
  })

  test('returns the underlying value when given a FiberFailure wrapping a die-channel TokenTimeout', () => {
    // The defect-channel counterpart — what `Effect.die(...)` (or an
    // unhandled throw) produces under `Effect.runPromise`. The unwrap
    // must reach into `Cause.dieOption` too, not just `failureOption`.
    const tokenTimeout = new TokenTimeout({})
    const wrapped = Runtime.makeFiberFailure(Cause.die(tokenTimeout))

    expect(unwrapFiberFailure(wrapped)).toBe(tokenTimeout)
  })

  test('returns the input unchanged when nothing is wrapped', () => {
    const plain = new Error('not a fiber failure')
    expect(unwrapFiberFailure(plain)).toBe(plain)
  })
})
