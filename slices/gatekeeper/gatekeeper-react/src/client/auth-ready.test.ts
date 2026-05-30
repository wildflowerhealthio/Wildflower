import { Duration, Effect, Either, Fiber, SubscriptionRef, TestClock, TestContext } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import {
  EMBEDDED_TOKEN_TIMEOUT,
  embeddedAuthReadyEffect,
  NeedsSignIn,
  TokenTimeout,
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

  test('rejects with NeedsSignIn when no token is present', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(null), (ref) => Effect.either(webAuthReadyEffect(ref)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(NeedsSignIn)
  })

  test('treats the empty string as absent (rejects)', async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(makeRef(''), (ref) => Effect.either(webAuthReadyEffect(ref)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(NeedsSignIn)
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
