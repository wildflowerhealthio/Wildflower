import { Duration, Effect, Fiber, MutableHashMap, Option, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  driveTransition,
  makeRunStore,
  SHORT_CONFIRM_WINDOW,
  type DriveObservation,
  type FailedResource,
  type ImportEvent,
  type RunPhase,
} from './sync-run.ts'

/**
 * Direct unit coverage of the extracted framework-free core
 * ({@link ./sync-run.ts}). This suite pins the {@link makeRunStore}
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

describe('makeRunStore', () => {
  describe('isSettled', () => {
    it('is false before sniffing is signalled complete', async () => {
      const sink = recordingSink()
      const settled = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
          return yield* sm.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(false)
    })

    it('is false while a response is still in-flight, even after sniff-complete', async () => {
      const sink = recordingSink()
      const settled = await runTest(
        Effect.gen(function* () {
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
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
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
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
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
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
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
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
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
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
          const sm = yield* makeRunStore(sink.setFailed, sink.onError)
          yield* sm.handleFailure({ label: 'Patient', id: '1' }, new Error('a'))
          yield* sm.handleFailure({ label: 'Observation', id: '2' }, new Error('b'))
          return yield* sm.summary
        })
      )
      expect(summary).toEqual({
        cancelled: false,
        failed: [
          { label: 'Patient', id: '1' },
          { label: 'Observation', id: '2' },
        ],
      })
      // setFailed receives the cumulative list each time (last call is complete).
      expect(sink.setFailedCalls.at(-1)).toEqual(summary.failed)
      expect(sink.onErrorCalls).toHaveLength(2)
    })

    it('summary.failed always mirrors every handled failure, in order (property)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ label: fc.string(), id: fc.string() })),
          async (failures) => {
            const sink = recordingSink()
            const summary = await runTest(
              Effect.gen(function* () {
                const sm = yield* makeRunStore(sink.setFailed, sink.onError)
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

describe('driveTransition', () => {
  it('processes a pulled event and stays in the current phase (so the loop continues)', () => {
    // Arrange
    const event = { _tag: 'sniffDone' } as const
    const observation: DriveObservation<unknown> = { _tag: 'Event', event }

    // Act
    const [nextPhase, effects] = driveTransition(draining, observation)

    // Assert
    expect(nextPhase).toEqual(draining)
    expect(effects).toEqual([{ _tag: 'ProcessEvent', event }])
  })

  it('terminates cleanly when quiescence still holds after the confirm window', () => {
    // Arrange
    const observation: DriveObservation<unknown> = { _tag: 'QuiescenceHeld' }

    // Act
    const [nextPhase, effects] = driveTransition(confirming, observation)

    // Assert
    expect(nextPhase).toEqual(terminated)
    expect(effects).toEqual([])
  })

  it('folds back to draining (no termination) when quiescence was lost', () => {
    // Arrange
    const observation: DriveObservation<unknown> = { _tag: 'QuiescenceLost' }

    // Act
    const [nextPhase, effects] = driveTransition(confirming, observation)

    // Assert
    expect(nextPhase).toEqual(draining)
    expect(effects).toEqual([])
  })

  it('terminates cleanly on an idle timeout with nothing in-flight', () => {
    // Arrange
    const observation: DriveObservation<unknown> = { _tag: 'IdleQuiet' }

    // Act
    const [nextPhase, effects] = driveTransition(draining, observation)

    // Assert
    expect(nextPhase).toEqual(terminated)
    expect(effects).toEqual([])
  })

  it('settles the stragglers then terminates on an idle timeout with responses in-flight', () => {
    // Arrange
    const observation: DriveObservation<unknown> = { _tag: 'IdleStragglers' }

    // Act
    const [nextPhase, effects] = driveTransition(draining, observation)

    // Assert
    expect(nextPhase).toEqual(terminated)
    expect(effects).toEqual([{ _tag: 'SettleStragglers' }])
  })

  it('always passes the live phase through unchanged for an Event, requesting exactly its ProcessEvent', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RunPhase>(draining, confirming),
        fc.constantFrom<ImportEvent<unknown>>(
          { _tag: 'sniffDone' },
          { _tag: 'parsed', resources: [] },
          { _tag: 'failure', error: new Error('x'), url: 'https://example.com/x' }
        ),
        (phase, event) => {
          // Act
          const [nextPhase, effects] = driveTransition(phase, { _tag: 'Event', event })

          // Assert — the Event arm never terminates and never inspects the event.
          expect(nextPhase).toEqual(phase)
          expect(effects).toEqual([{ _tag: 'ProcessEvent', event }])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('never depends on the incoming phase for a terminating observation', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RunPhase>(draining, confirming, terminated),
        fc.constantFrom<DriveObservation<unknown>>(
          { _tag: 'QuiescenceHeld' },
          { _tag: 'IdleQuiet' },
          { _tag: 'IdleStragglers' }
        ),
        (phase, observation) => {
          // Act — a terminating observation ignores the phase it arrives in.
          const [fromPhase] = driveTransition(phase, observation)
          const [fromDraining] = driveTransition(draining, observation)

          // Assert
          expect(fromPhase).toEqual(terminated)
          expect(fromPhase).toEqual(fromDraining)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers
const draining: RunPhase = { _tag: 'Draining' }
const confirming: RunPhase = { _tag: 'Confirming' }
const terminated: RunPhase = { _tag: 'Terminated' }
