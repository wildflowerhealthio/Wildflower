import type { CollectorDescriptor } from 'collector-fundamentals/model'
import { Duration, Effect, Either, Fiber, Mailbox, Stream, TestClock, TestContext } from 'effect'
import { UnknownException } from 'effect/Cause'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  buildDriveStream,
  collectImportSummary,
  type FailedResource,
  type SniffResult,
} from './sync-run.ts'

/**
 * Direct unit coverage of the extracted framework-free core
 * ({@link ./sync-run.ts}), without React Testing Library. Two suites:
 *
 * - {@link collectImportSummary} — the fold that turns the drive stream's
 *   per-step failure chunks into the `ImportSummary` (and drives `setFailed` /
 *   `onError`).
 * - {@link buildDriveStream} — the drive loop itself, over `TestClock`: results
 *   are drained until the mailbox is `done`, and an idle timeout triggers the
 *   injected abandon action.
 *
 * Write-retry exhaustion (the persist sink) is covered by
 * `fhir-r4-client-collector/src/persist.test.ts`. Closing the
 * `requestSniffingResults` stream (when the handler closes it) is covered in
 * `collector-fundamentals/.../run-lifecycle-state.test.ts`.
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
  it('processes every queued result, then terminates once the mailbox is done', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const source = yield* Mailbox.make<SniffResult<unknown>>()
        yield* source.offer(Either.right([]))
        yield* source.offer(
          Either.left({ error: new UnknownException('x'), url: 'https://example.com/x' })
        )
        yield* source.end

        // A done, drained mailbox makes `take` fail immediately, so the loop
        // drains both queued results then stops — no clock needed.
        yield* Fiber.join(yield* Effect.fork(drive(source, neverIdle(source), rec)))
      })
    )
    expect(rec.processed.map((e) => (Either.isRight(e) ? 'parsed' : 'responseFailure'))).toEqual([
      'parsed',
      'responseFailure',
    ])
  })

  it('terminates immediately when the mailbox is done and empty', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const source = yield* Mailbox.make<SniffResult<unknown>>()
        yield* source.end
        yield* Fiber.join(yield* Effect.fork(drive(source, neverIdle(source), rec)))
      })
    )
    expect(rec.processed).toEqual([])
  })

  it('runs onIdleTimeout when nothing arrives within the idle timeout, then terminates', async () => {
    const rec = recorder()
    let idled = false
    await runTest(
      Effect.gen(function* () {
        const source = yield* Mailbox.make<SniffResult<unknown>>()
        // The abandon action records the idle trip and ends the mailbox so the
        // loop can then observe `done`.
        const onIdleTimeout = Effect.sync(() => {
          idled = true
        }).pipe(Effect.andThen(source.end))

        const fiber = yield* Effect.fork(drive(source, onIdleTimeout, rec))
        yield* TestClock.adjust(IDLE_TIMEOUT)
        yield* Fiber.join(fiber)
      })
    )
    expect(idled).toBe(true)
    expect(rec.processed).toEqual([])
  })

  it('drains a failure the abandon action offers on idle, then terminates', async () => {
    const rec = recorder()
    await runTest(
      Effect.gen(function* () {
        const source = yield* Mailbox.make<SniffResult<unknown>>()
        // Mirrors `abandonAllRequestSniffing`: fail a stalled request as a Left, then close.
        const onIdleTimeout = source
          .offer(
            Either.left({
              error: new UnknownException('stalled'),
              url: 'https://example.com/slow',
            })
          )
          .pipe(Effect.andThen(source.end))

        const fiber = yield* Effect.fork(drive(source, onIdleTimeout, rec))
        yield* TestClock.adjust(IDLE_TIMEOUT)
        yield* Fiber.join(fiber)
      })
    )
    // The abandoned response is drained as a normal Left result after the idle trip.
    expect(rec.processed).toHaveLength(1)
    expect(Either.isLeft(rec.processed[0])).toBe(true)
  })
})

// Helpers

const IDLE_TIMEOUT = Duration.seconds(30)

/**
 * A recording `processEvent` sink so each `buildDriveStream` test can read back
 * what the loop drove. It returns no failures (`[]`); the failure-folding path
 * is covered by `collectImportSummary` above.
 */
const recorder = (): {
  readonly processed: Array<SniffResult<unknown>>
  readonly processEvent: (
    event: SniffResult<unknown>
  ) => Effect.Effect<ReadonlyArray<PersistFailure>>
} => {
  const processed: Array<SniffResult<unknown>> = []
  return {
    processed,
    processEvent: (event: SniffResult<unknown>): Effect.Effect<ReadonlyArray<PersistFailure>> =>
      Effect.sync(() => {
        processed.push(event)
        return []
      }),
  }
}

/**
 * An `onIdleTimeout` for tests that should never idle: it just `end`s the
 * mailbox (harmless — those tests end it up front), so an unexpected idle trip
 * still terminates rather than hanging the test.
 */
const neverIdle = (source: Mailbox.Mailbox<SniffResult<unknown>>): Effect.Effect<void> =>
  source.end.pipe(Effect.asVoid)

const drive = (
  results: Mailbox.ReadonlyMailbox<SniffResult<unknown>>,
  onIdleTimeout: Effect.Effect<void>,
  rec: ReturnType<typeof recorder>
): Effect.Effect<void> =>
  Stream.runDrain(
    buildDriveStream({
      results,
      processEvent: rec.processEvent,
      onIdleTimeout,
      idleTimeout: IDLE_TIMEOUT,
    })
  )
