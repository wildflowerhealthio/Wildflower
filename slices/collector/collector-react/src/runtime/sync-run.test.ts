import { Duration, Effect, Fiber, MutableHashMap, Option, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { makeRunStateMachine, SHORT_CONFIRM_WINDOW, type FailedResource } from './sync-run.ts'

/**
 * Direct unit coverage of the extracted framework-free core
 * ({@link ./sync-run.ts}). This suite pins the {@link makeRunStateMachine}
 * completion predicate and failure accounting — the facts the drive loop
 * reads to decide "are we done?" and to build the `partial` summary —
 * without React Testing Library.
 *
 * The full drive loop (`buildImportEffect`: quiescence re-confirm across
 * `SHORT_CONFIRM_WINDOW`, the idle-timeout `settleInFlightAsFailures` path,
 * and write-retry exhaustion) is exercised against a stub persistence sink
 * once the sink is injectable — see the runner tests that land with the
 * descriptor seam (3B of epic #382).
 */

/** Collects the arrays `setFailed` was called with, newest last. */
const recordingSink = (): {
  readonly setFailed: (failed: ReadonlyArray<FailedResource>) => void
  readonly onError: (error: unknown) => void
  readonly setFailedCalls: Array<ReadonlyArray<FailedResource>>
  readonly onErrorCalls: Array<unknown>
} => {
  const setFailedCalls: Array<ReadonlyArray<FailedResource>> = []
  const onErrorCalls: Array<unknown> = []
  return {
    setFailed: (failed) => {
      setFailedCalls.push(failed)
    },
    onError: (error) => {
      onErrorCalls.push(error)
    },
    setFailedCalls,
    onErrorCalls,
  }
}

const runTest = <A>(program: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

describe('makeRunStateMachine', () => {
  describe('isSettled', () => {
    it('is false before sniffing is signalled complete', async () => {
      const sink = recordingSink()
      const settled = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          return yield* sm.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(false)
    })

    it('is false while a response is still in-flight, even after sniff-complete', async () => {
      const sink = recordingSink()
      const settled = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          yield* sm.signalSniffComplete
          // Drain the `sniffDone` wake event so only the in-flight response
          // keeps it unsettled.
          yield* sm.tryTakeEvent(Duration.zero)
          const inProgress = MutableHashMap.make(['https://example.com/Patient/1', {}])
          return yield* sm.isSettled(inProgress)
        })
      )
      expect(settled).toBe(false)
    })

    it('is false while an event is still queued', async () => {
      const sink = recordingSink()
      const settled = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          yield* sm.signalSniffComplete
          sm.offerParsed([])
          return yield* sm.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(false)
    })

    it('is true once sniffing is complete, nothing is in-flight, and the mailbox is drained', async () => {
      const sink = recordingSink()
      const settled = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          yield* sm.signalSniffComplete
          yield* sm.tryTakeEvent(Duration.zero)
          return yield* sm.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(true)
    })
  })

  describe('tryTakeEvent', () => {
    it('returns a queued event immediately', async () => {
      const sink = recordingSink()
      const event = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          sm.offerFailure(new Error('boom'), 'https://example.com/x')
          return yield* sm.tryTakeEvent(SHORT_CONFIRM_WINDOW)
        })
      )
      expect(Option.getOrThrow(event)).toMatchObject({
        _tag: 'failure',
        url: 'https://example.com/x',
      })
    })

    it('resolves to None after the window elapses on an empty mailbox', async () => {
      const sink = recordingSink()
      const event = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          const fiber = yield* Effect.fork(sm.tryTakeEvent(SHORT_CONFIRM_WINDOW))
          yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)
          return yield* Fiber.join(fiber)
        })
      )
      expect(Option.isNone(event)).toBe(true)
    })
  })

  describe('handleFailure', () => {
    it('accumulates failures, pushes the growing list to setFailed, and fires onError once each', async () => {
      const sink = recordingSink()
      const summary = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
          yield* sm.handleFailure({ resourceType: 'Patient', id: '1' }, new Error('a'))
          yield* sm.handleFailure({ resourceType: 'Observation', id: '2' }, new Error('b'))
          return yield* sm.summary
        })
      )
      expect(summary).toEqual({
        cancelled: false,
        failed: [
          { resourceType: 'Patient', id: '1' },
          { resourceType: 'Observation', id: '2' },
        ],
      })
      // setFailed receives the cumulative list each time (last call is complete).
      expect(sink.setFailedCalls.at(-1)).toEqual(summary.failed)
      expect(sink.onErrorCalls).toHaveLength(2)
    })

    it('summary.failed always mirrors every handled failure, in order (property)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ resourceType: fc.string(), id: fc.string() })),
          async (failures) => {
            const sink = recordingSink()
            const summary = await runTest(
              Effect.gen(function* () {
                const sm = yield* makeRunStateMachine(sink.setFailed, sink.onError)
                yield* Effect.forEach(failures, (failed) =>
                  sm.handleFailure(failed, new Error(failed.id))
                )
                return yield* sm.summary
              })
            )
            expect(summary.cancelled).toBe(false)
            expect(summary.failed).toEqual(failures)
            expect(sink.onErrorCalls).toHaveLength(failures.length)
          }
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
