import { Duration, Effect, Fiber, MutableHashMap, Option, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  driveUntilSettled,
  makeRunStore,
  SHORT_CONFIRM_WINDOW,
  type FailedResource,
  type ImportEvent,
} from './sync-run.ts'

/**
 * Direct unit coverage of the extracted framework-free core
 * ({@link ./sync-run.ts}), without React Testing Library. Two suites:
 *
 * - {@link makeRunStore} — the completion predicate (`isSettled`) and
 *   failure accounting the loop reads to decide "are we done?".
 * - {@link driveUntilSettled} — the drive loop itself, over `TestClock`:
 *   events are processed, quiescence terminates the run, and an idle
 *   timeout with responses still in-flight settles the stragglers.
 *
 * Write-retry exhaustion (inside `buildImportEffect`, against a real
 * persistence sink) is covered by `fhir-r4-client-collector/src/persist.test.ts`.
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

/** No-op sink callback for tests that assert on the loop, not on failures. */
const noop = (): void => {}

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

describe('driveUntilSettled', () => {
  // A recording `processEvent` sink plus a one-shot `settleStragglers` flag,
  // so each test can read back what the loop drove.
  const recorder = (): {
    readonly processed: Array<ImportEvent<unknown>>
    readonly processEvent: (event: ImportEvent<unknown>) => Effect.Effect<void>
    readonly settleStragglers: Effect.Effect<void>
    settled: boolean
  } => {
    const processed: Array<ImportEvent<unknown>> = []
    const state = {
      processed,
      settled: false,
      processEvent: (event: ImportEvent<unknown>) =>
        Effect.sync(() => {
          processed.push(event)
        }),
      settleStragglers: Effect.sync(() => {
        state.settled = true
      }),
    }
    return state
  }

  const drive = (
    store: Parameters<typeof driveUntilSettled>[0]['store'],
    inProgress: MutableHashMap.MutableHashMap<string, unknown>,
    rec: ReturnType<typeof recorder>
  ): Effect.Effect<void> =>
    driveUntilSettled({
      store,
      inProgressResponses: inProgress,
      processEvent: rec.processEvent,
      settleStragglers: rec.settleStragglers,
      idleTimeout: IDLE_TIMEOUT,
    })

  const IDLE_TIMEOUT = Duration.seconds(30)

  it('processes every queued event, then terminates once quiescence holds', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const store = yield* makeRunStore(noop, noop)
        const inProgress = MutableHashMap.empty<string, unknown>()
        // Sniffing is done and two decoded batches are already queued.
        yield* store.signalSniffComplete
        store.offerParsed([])
        store.offerFailure(new Error('x'), 'https://example.com/x')

        const fiber = yield* Effect.fork(drive(store, inProgress, rec))
        // The queued events drain immediately; the loop then blocks on the
        // confirm window, which the clock closes to terminate the run.
        yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)
        yield* Fiber.join(fiber)
      })
    )
    // sniffDone (from signalSniffComplete) + the two offered events, in order.
    expect(rec.processed.map((e) => e._tag)).toEqual(['sniffDone', 'parsed', 'failure'])
    expect(rec.settled).toBe(false)
  })

  it('terminates on quiescence with an empty mailbox, settling nothing', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const store = yield* makeRunStore(noop, noop)
        const inProgress = MutableHashMap.empty<string, unknown>()
        yield* store.signalSniffComplete
        yield* store.tryTakeEvent(Duration.zero) // drain the `sniffDone` wake

        const fiber = yield* Effect.fork(drive(store, inProgress, rec))
        yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)
        yield* Fiber.join(fiber)
      })
    )
    expect(rec.processed).toEqual([])
    expect(rec.settled).toBe(false)
  })

  it('terminates on an idle timeout with nothing in-flight, settling nothing', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        // Sniffing never completes and nothing is in-flight: the host has
        // gone silent, so the idle timeout ends the run.
        const store = yield* makeRunStore(noop, noop)
        const inProgress = MutableHashMap.empty<string, unknown>()

        const fiber = yield* Effect.fork(drive(store, inProgress, rec))
        yield* TestClock.adjust(IDLE_TIMEOUT)
        yield* Fiber.join(fiber)
      })
    )
    expect(rec.processed).toEqual([])
    expect(rec.settled).toBe(false)
  })

  it('settles stragglers then terminates on an idle timeout with a response still in-flight', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const store = yield* makeRunStore(noop, noop)
        // A response is mid-stream (its data chunks never wake the loop),
        // so the idle timeout must settle it as a failure.
        const inProgress = MutableHashMap.make(['https://example.com/Patient/1', {}])

        const fiber = yield* Effect.fork(drive(store, inProgress, rec))
        yield* TestClock.adjust(IDLE_TIMEOUT)
        yield* Fiber.join(fiber)
      })
    )
    expect(rec.settled).toBe(true)
    expect(rec.processed).toEqual([])
  })

  it('keeps draining (does not terminate) when a straggler re-enters during the confirm window', async () => {
    const rec = recorder()
    const stillRunning = await runTest(
      Effect.gen(function* () {
        const store = yield* makeRunStore(noop, noop)
        const inProgress = MutableHashMap.empty<string, unknown>()
        // Quiescence holds, so the loop enters the short confirm window…
        yield* store.signalSniffComplete
        yield* store.tryTakeEvent(Duration.zero)

        const fiber = yield* Effect.fork(drive(store, inProgress, rec))
        // …but a response re-enters before the window closes, so the
        // re-confirm sees the run un-settled and keeps draining.
        yield* TestClock.adjust(Duration.millis(100))
        MutableHashMap.set(inProgress, 'https://example.com/Patient/1', {})
        yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)

        const poll = yield* Fiber.poll(fiber)
        yield* Fiber.interrupt(fiber)
        return Option.isNone(poll)
      })
    )
    expect(stillRunning).toBe(true)
    expect(rec.settled).toBe(false)
  })
})
