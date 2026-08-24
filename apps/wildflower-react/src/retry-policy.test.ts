import { Duration, Effect, Either, Fiber, Ref, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { responseErrorWithStatus } from './auth-error-fixtures.ts'
import { unauthorizedRetrySchedule } from './retry-policy.ts'

describe('unauthorizedRetrySchedule (boot-race retry)', () => {
  it('re-sends a persistent 401 the bounded number of times, then propagates', async () => {
    // Arrange / Act — driven on TestClock so the spacing is exercised without
    // real time.
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.flatMap(
        Ref.updateAndGet(attempts, (n) => n + 1),
        () => Effect.fail(responseErrorWithStatus(401))
      )
      const fiber = yield* Effect.fork(
        Effect.either(Effect.retry(failing, unauthorizedRetrySchedule))
      )
      // Push past every spaced re-send.
      yield* TestClock.adjust(Duration.millis(1000))
      const result = yield* Fiber.join(fiber)
      return { result, count: yield* Ref.get(attempts) }
    }).pipe(Effect.provide(TestContext.TestContext))

    const { result, count } = await Effect.runPromise(program)

    // Assert — one initial send plus three re-sends, and it still fails.
    expect(count).toBe(4)
    expect(Either.isLeft(result)).toBe(true)
  })

  it('stops re-sending as soon as a 401 clears', async () => {
    // Arrange / Act — 401 twice, then the cookie has landed and it succeeds.
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const flaky = Effect.flatMap(
        Ref.updateAndGet(attempts, (n) => n + 1),
        (n) => (n <= 2 ? Effect.fail(responseErrorWithStatus(401)) : Effect.succeed('ok'))
      )
      const fiber = yield* Effect.fork(Effect.retry(flaky, unauthorizedRetrySchedule))
      yield* TestClock.adjust(Duration.millis(1000))
      return { value: yield* Fiber.join(fiber), count: yield* Ref.get(attempts) }
    }).pipe(Effect.provide(TestContext.TestContext))

    const { value, count } = await Effect.runPromise(program)

    // Assert — resolved on the third attempt (two re-sends), no further sends.
    expect(value).toBe('ok')
    expect(count).toBe(3)
  })

  it('does not re-send a non-401 failure', async () => {
    // Arrange / Act
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing = Effect.flatMap(
        Ref.updateAndGet(attempts, (n) => n + 1),
        () => Effect.fail(responseErrorWithStatus(500))
      )
      const result = yield* Effect.either(Effect.retry(failing, unauthorizedRetrySchedule))
      return { result, count: yield* Ref.get(attempts) }
    }).pipe(Effect.provide(TestContext.TestContext))

    const { result, count } = await Effect.runPromise(program)

    // Assert — a single send, no re-send.
    expect(Either.isLeft(result)).toBe(true)
    expect(count).toBe(1)
  })
})
