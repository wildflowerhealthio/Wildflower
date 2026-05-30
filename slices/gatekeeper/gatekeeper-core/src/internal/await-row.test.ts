import type { LiveQueryDef } from '@livestore/livestore'
import { Duration, Effect, Either, Exit, Fiber, TestClock, TestContext } from 'effect'
import { expect, test } from 'vite-plus/test'
import { GatekeeperStore } from '../livestore/index.ts'
import { ApprovalTimedOut, GATE_TIMEOUT, waitForRow } from './await-row.ts'
type Row = { id: string; status: 'pending' | 'approved' }
type Subscriber = (row: Row | null | undefined) => void

const makeFakeStore = (hooks: {
  onSubscribe: (cb: Subscriber) => () => void
}): typeof GatekeeperStore.Service => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    query: (_q: unknown) => null,
    commit: () => undefined,
    subscribe: (_q: unknown, cb: (value: unknown) => void) => {
      return hooks.onSubscribe(cb)
    },
  } as unknown as typeof GatekeeperStore.Service
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const fakeQuery = null as unknown as LiveQueryDef<Row | null | undefined>

test('resolves with the row when predicate matches', async () => {
  const subscribers: Subscriber[] = []
  let disposed = false
  const fakeStore = makeFakeStore({
    onSubscribe: (callback) => {
      subscribers.push(callback)
      return () => {
        disposed = true
      }
    },
  })

  const fiber = Effect.runPromise(
    waitForRow(fakeQuery, (row: Row) => row.status === 'approved', 'req-1').pipe(
      Effect.provide(GatekeeperStore.layerFrom(fakeStore)),
      Effect.either
    )
  )

  // Yield to let Effect.async install the subscription.
  await new Promise<void>((r) => setTimeout(r, 0))
  const cb = subscribers[0]
  if (cb === undefined) throw new Error('subscriber never registered')
  cb({ id: 'req-1', status: 'pending' })
  cb({ id: 'req-1', status: 'approved' })

  const result = await fiber
  expect(result).toEqual(Either.right({ id: 'req-1', status: 'approved' }))
  expect(disposed).toBe(true)
})

test('disposes the subscription when the fiber is interrupted', async () => {
  let disposed = false
  const fakeStore = makeFakeStore({
    onSubscribe: () => () => {
      disposed = true
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        waitForRow(fakeQuery, (row: Row) => row.status === 'approved', 'req-2').pipe(
          Effect.provide(GatekeeperStore.layerFrom(fakeStore))
        )
      )
      // Give the subscription a chance to install before interrupting.
      yield* Effect.yieldNow()
      yield* Effect.yieldNow()
      yield* Fiber.interrupt(fiber)
    })
  )

  expect(disposed).toBe(true)
})

test('fails with ApprovalTimedOut after GATE_TIMEOUT elapses', async () => {
  const fakeStore = makeFakeStore({
    onSubscribe: () => () => {},
  })

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        waitForRow(fakeQuery, (row: Row) => row.status === 'approved', 'req-3').pipe(
          Effect.provide(GatekeeperStore.layerFrom(fakeStore))
        )
      )
      yield* TestClock.adjust(Duration.sum(GATE_TIMEOUT, Duration.seconds(1)))
      return yield* fiber.await
    }).pipe(Effect.provide(TestContext.TestContext))
  )

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const cause = exit.cause
    if (cause._tag === 'Fail') {
      expect(cause.error).toBeInstanceOf(ApprovalTimedOut)
      expect(cause.error.id).toBe('req-3')
    } else {
      throw new Error(`Expected Fail cause, got ${cause._tag}`)
    }
  }
})
