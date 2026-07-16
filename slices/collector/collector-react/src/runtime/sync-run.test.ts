import type { CollectorDescriptor } from 'collector-fundamentals/model'
import {
  Duration,
  Effect,
  Fiber,
  MutableHashMap,
  Option,
  Stream,
  TestClock,
  TestContext,
} from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  buildDriveStream,
  collectImportSummary,
  RunStore,
  SHORT_CONFIRM_WINDOW,
  type FailedResource,
  type RunEvent,
} from './sync-run.ts'

/**
 * Direct unit coverage of the extracted framework-free core
 * ({@link ./sync-run.ts}), without React Testing Library. Three suites:
 *
 * - {@link RunStore} — the completion predicate (`isSettled`) and the event
 *   mailbox (`tryTakeEvent`) the drive loop reads to decide "are we done?".
 * - {@link collectImportSummary} — the fold that turns the drive stream's
 *   per-step failure chunks into the `ImportSummary` (and drives `setFailed` /
 *   `onError`).
 * - {@link buildDriveStream} — the drive loop itself, over `TestClock`: events
 *   are processed, quiescence terminates the run, and an idle timeout with
 *   responses still in-flight settles the stragglers.
 *
 * Write-retry exhaustion (the persist sink) is covered by
 * `fhir-r4-client-collector/src/persist.test.ts`.
 */

type PersistFailure = CollectorDescriptor.PersistFailure

const runTest = <A>(program: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

/** Records the arrays `setFailed` was called with and the causes `onError` saw. */
class RecordingSink {
  readonly setFailedCalls: Array<ReadonlyArray<FailedResource>> = []
  readonly onErrorCalls: Array<unknown> = []
  readonly setFailed = (failed: ReadonlyArray<FailedResource>): void => {
    this.setFailedCalls.push(failed)
  }
  readonly onError = (cause: unknown): void => {
    this.onErrorCalls.push(cause)
  }
}

describe('RunStore', () => {
  describe('isSettled', () => {
    it('is false before sniffing is signalled complete', async () => {
      const settled = await runTest(
        Effect.gen(function* () {
          const store = yield* RunStore.make()
          return yield* store.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(false)
    })

    it('is false while a response is still in-flight, even after sniff-complete', async () => {
      const settled = await runTest(
        Effect.gen(function* () {
          const store = yield* RunStore.make()
          yield* store.signalSniffComplete
          // Drain the `sniffDone` wake event so only the in-flight response
          // keeps it unsettled.
          yield* store.tryTakeEvent(Duration.zero)
          const inProgress = MutableHashMap.make(['https://example.com/Patient/1', {}])
          return yield* store.isSettled(inProgress)
        })
      )
      expect(settled).toBe(false)
    })

    it('is false while an event is still queued', async () => {
      const settled = await runTest(
        Effect.gen(function* () {
          const store = yield* RunStore.make()
          yield* store.signalSniffComplete
          store.offerParsed([])
          return yield* store.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(false)
    })

    it('is true once sniffing is complete, nothing is in-flight, and the mailbox is drained', async () => {
      const settled = await runTest(
        Effect.gen(function* () {
          const store = yield* RunStore.make()
          yield* store.signalSniffComplete
          yield* store.tryTakeEvent(Duration.zero)
          return yield* store.isSettled(MutableHashMap.empty())
        })
      )
      expect(settled).toBe(true)
    })
  })

  describe('tryTakeEvent', () => {
    it('returns a queued event immediately', async () => {
      const event = await runTest(
        Effect.gen(function* () {
          const store = yield* RunStore.make()
          store.offerResponseFailure(new Error('boom'), 'https://example.com/x')
          return yield* store.tryTakeEvent(SHORT_CONFIRM_WINDOW)
        })
      )
      expect(Option.getOrThrow(event)).toMatchObject({
        _tag: 'responseFailure',
        url: 'https://example.com/x',
      })
    })

    it('resolves to None after the window elapses on an empty mailbox', async () => {
      const event = await runTest(
        Effect.gen(function* () {
          const store = yield* RunStore.make()
          const fiber = yield* Effect.fork(store.tryTakeEvent(SHORT_CONFIRM_WINDOW))
          yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)
          return yield* Fiber.join(fiber)
        })
      )
      expect(Option.isNone(event)).toBe(true)
    })
  })
})

describe('collectImportSummary', () => {
  it('accumulates every failure, pushes the growing list to setFailed, and fires onError once each', async () => {
    const sink = new RecordingSink()
    const summary = await runTest(
      collectImportSummary(
        Stream.fromIterable<ReadonlyArray<PersistFailure>>([
          [{ failed: { label: 'Patient', id: '1' }, cause: new Error('a') }],
          [{ failed: { label: 'Observation', id: '2' }, cause: new Error('b') }],
        ]),
        sink.setFailed,
        sink.onError
      )
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

  it('summary.failed always mirrors every failure, in stream order (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ label: fc.string(), id: fc.string() })),
        async (failures) => {
          const sink = new RecordingSink()
          // One failure per emitted chunk, mirroring a batch that failed
          // resource-by-resource.
          const chunks: ReadonlyArray<ReadonlyArray<PersistFailure>> = failures.map((failed) => [
            { failed, cause: new Error(failed.id) },
          ])
          const summary = await runTest(
            collectImportSummary(Stream.fromIterable(chunks), sink.setFailed, sink.onError)
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

describe('buildDriveStream', () => {
  it('processes every queued event, then terminates once quiescence holds', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const store = yield* RunStore.make<unknown>()
        const inProgress = MutableHashMap.empty<string, unknown>()
        // Sniffing is done and two decoded batches are already queued.
        yield* store.signalSniffComplete
        store.offerParsed([])
        store.offerResponseFailure(new Error('x'), 'https://example.com/x')

        const fiber = yield* Effect.fork(drive(store, inProgress, rec))
        // The queued events drain immediately; the loop then blocks on the
        // confirm window, which the clock closes to terminate the run.
        yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)
        yield* Fiber.join(fiber)
      })
    )
    // sniffDone (from signalSniffComplete) + the two offered events, in order.
    expect(rec.processed.map((e) => e._tag)).toEqual(['sniffDone', 'parsed', 'responseFailure'])
    expect(rec.settled).toBe(false)
  })

  it('terminates on quiescence with an empty mailbox, settling nothing', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const store = yield* RunStore.make<unknown>()
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
        const store = yield* RunStore.make<unknown>()
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
        const store = yield* RunStore.make<unknown>()
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
        const store = yield* RunStore.make<unknown>()
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

// Helpers

const IDLE_TIMEOUT = Duration.seconds(30)

/**
 * A recording `processEvent` sink plus a one-shot `settleStragglers` flag, so
 * each `buildDriveStream` test can read back what the loop drove. Both actions
 * return no failures (`[]`); the failure-folding path is covered by
 * `collectImportSummary` above.
 */
const recorder = (): {
  readonly processed: Array<RunEvent<unknown>>
  readonly processEvent: (event: RunEvent<unknown>) => Effect.Effect<ReadonlyArray<PersistFailure>>
  readonly settleStragglers: Effect.Effect<ReadonlyArray<PersistFailure>>
  settled: boolean
} => {
  const processed: Array<RunEvent<unknown>> = []
  const state = {
    processed,
    settled: false,
    processEvent: (event: RunEvent<unknown>): Effect.Effect<ReadonlyArray<PersistFailure>> =>
      Effect.sync(() => {
        processed.push(event)
        return []
      }),
    settleStragglers: Effect.sync((): ReadonlyArray<PersistFailure> => {
      state.settled = true
      return []
    }),
  }
  return state
}

const drive = (
  store: RunStore<unknown>,
  inProgress: MutableHashMap.MutableHashMap<string, unknown>,
  rec: ReturnType<typeof recorder>
): Effect.Effect<void> =>
  Stream.runDrain(
    buildDriveStream({
      store,
      inProgressResponses: inProgress,
      processEvent: rec.processEvent,
      settleStragglers: rec.settleStragglers,
      idleTimeout: IDLE_TIMEOUT,
    })
  )
