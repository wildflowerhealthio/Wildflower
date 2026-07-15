import { type AnyCollectorResource } from 'collector-registry/registry'
import { Duration, Effect, Fiber, Layer, MutableHashMap, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesHttpApiClientShape,
} from 'fhir-r4/clients'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  type FailedResource,
  makeRunStateMachine,
  runDriveLoop,
  SHORT_CONFIRM_WINDOW,
  writeResourceWithRetries,
} from './sync-run.ts'

/**
 * Direct unit coverage for the framework-free sync-run core, driven with
 * `TestClock` so the quiescence / idle-timeout / write-retry paths — which
 * were previously reachable only through a rendered `useSyncRunner` — are
 * exercised deterministically without React Testing Library.
 */

/** A short idle window so the not-settled branch is easy to advance past. */
const IDLE_TIMEOUT = Duration.seconds(30)

/** Deterministic ordering for comparing an unordered failure set. */
const sortById = (failed: ReadonlyArray<FailedResource>): ReadonlyArray<FailedResource> =>
  [...failed].toSorted((a, b) => a.id.localeCompare(b.id))

/** The `{ resourceType: 'response' }` failures the idle path records per url. */
const responseFailures = (urls: ReadonlyArray<string>): ReadonlyArray<FailedResource> =>
  urls.map((url) => ({ resourceType: 'response', id: url }))

/**
 * Capture what the injected callbacks saw, so a test can assert that
 * `setFailed` mirrors the accumulated failures and `onError` fired once per
 * failed item — the plain-function contract the core is built around.
 */
const makeSpy = (): {
  readonly setFailedCalls: ReadonlyArray<FailedResource>[]
  readonly onErrorCalls: unknown[]
  readonly setFailed: (failed: ReadonlyArray<FailedResource>) => void
  readonly onError: (error: unknown) => void
} => {
  const setFailedCalls: ReadonlyArray<FailedResource>[] = []
  const onErrorCalls: unknown[] = []
  return {
    setFailedCalls,
    onErrorCalls,
    setFailed: (failed) => setFailedCalls.push(failed),
    onError: (error) => onErrorCalls.push(error),
  }
}

/** An in-flight-response tracker seeded with the given response urls. */
const trackerFor = (
  urls: ReadonlyArray<string>
): MutableHashMap.MutableHashMap<string, { readonly response: { readonly url: string } }> =>
  MutableHashMap.fromIterable(urls.map((url) => [url, { response: { url } }] as const))

/**
 * Run a `TestClock`-driven program under a capturing logger so warn/error
 * logs on the failure paths don't spill to the console; returns the value
 * plus the captured entries for assertions. `program`'s requirements are
 * already discharged (`R = never`) — `TestClock.adjust` reads the clock from
 * default services, which `TestContext` overrides with the test clock.
 */
const runWithTestClock = async <A>(
  program: Effect.Effect<A>
): Promise<{ readonly value: A; readonly logs: LoggingLayerTest.CapturedLog[] }> => {
  const { layer: logLayer, logSink } = LoggingLayerTest.make()
  const value = await Effect.runPromise(
    program.pipe(Effect.provide(logLayer), Effect.provide(TestContext.TestContext))
  )
  return { value, logs: logSink }
}

describe('writeResourceWithRetries', () => {
  // The write path only reaches `Patient.Update` for a Patient resource, and
  // the stub below never encodes the payload — so a minimal Patient-shaped
  // literal is a faithful stand-in. The cast narrows it to the generated
  // resource union without weakening what the retry test asserts.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- opaque stand-in; the code under test reads only resourceType/id and the stub client never encodes it
  const patientResource = { resourceType: 'Patient', id: 'p1' } as unknown as AnyCollectorResource

  // The generated client shape is large; this one-method stub is all the
  // retry-exhaustion path touches (`Patient.Update`), so casting it to the
  // full client shape doesn't weaken the test.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- one-method stub of the generated FHIR client; the write path only reaches Patient.Update
  const failingClientService = {
    Patient: { Update: () => Effect.fail(new Error('upstream 500')) },
  } as unknown as FhirR4ResourcesHttpApiClientShape

  /** A client whose `Patient.Update` always rejects, to exhaust the retries. */
  const alwaysFailingFhirClient: Layer.Layer<FhirR4ResourcesHttpApiClient> = Layer.succeed(
    FhirR4ResourcesHttpApiClient,
    failingClientService
  )

  it('exhausts retries, then records the item as a failure and fires onError once (→ partial summary)', async () => {
    const spy = makeSpy()

    const { value: summary } = await runWithTestClock(
      Effect.gen(function* () {
        const sm = yield* makeRunStateMachine(spy.setFailed, spy.onError)
        const fiber = yield* Effect.fork(
          writeResourceWithRetries(sm, patientResource, 'p1').pipe(
            Effect.provide(alwaysFailingFhirClient)
          )
        )
        // Bounded exponential backoff is 250ms → 500ms → 1s (3 retries);
        // 2s clears all of them.
        yield* TestClock.adjust(Duration.seconds(2))
        yield* Fiber.join(fiber)
        return yield* sm.summary
      })
    )

    // The run never fails — the exhausted write is *recorded*, surfacing as
    // a `partial` (non-cancelled) summary carrying the one failed item.
    expect(summary.cancelled).toBe(false)
    expect(summary.failed).toEqual([{ resourceType: 'Patient', id: 'p1' }])
    // `onError` fires exactly once, after retries are exhausted — not per
    // attempt — and `setFailed` mirrors the accumulated list.
    expect(spy.onErrorCalls).toHaveLength(1)
    expect(spy.setFailedCalls.at(-1)).toEqual([{ resourceType: 'Patient', id: 'p1' }])
  })
})

describe('runDriveLoop', () => {
  const noopProcess = (): Effect.Effect<void> => Effect.void

  it('terminates once quiescence re-confirms across SHORT_CONFIRM_WINDOW', async () => {
    const spy = makeSpy()

    const { value: summary } = await runWithTestClock(
      Effect.gen(function* () {
        const sm = yield* makeRunStateMachine(spy.setFailed, spy.onError)
        // Sniffing dispatched its terminal step (also queues a `sniffDone`
        // wake), nothing is mid-stream, and no writes are pending.
        yield* sm.signalSniffComplete
        const fiber = yield* Effect.fork(
          runDriveLoop({
            stateMachine: sm,
            inProgressResponses: trackerFor([]),
            idleTimeout: IDLE_TIMEOUT,
            processStateEvent: noopProcess,
          })
        )
        // First iteration drains the `sniffDone` immediately; the next sees
        // quiescence and waits the short window before re-confirming.
        yield* TestClock.adjust(SHORT_CONFIRM_WINDOW)
        yield* Fiber.join(fiber)
        return yield* sm.summary
      })
    )

    expect(summary).toEqual({ failed: [], cancelled: false })
    expect(spy.onErrorCalls).toHaveLength(0)
  })

  it('terminates cleanly on idle timeout when nothing is in-flight', async () => {
    const spy = makeSpy()

    const { value: summary, logs } = await runWithTestClock(
      Effect.gen(function* () {
        // No `signalSniffComplete`: the run is never settled, so the loop
        // waits the full idle window with an empty mailbox.
        const sm = yield* makeRunStateMachine(spy.setFailed, spy.onError)
        const fiber = yield* Effect.fork(
          runDriveLoop({
            stateMachine: sm,
            inProgressResponses: trackerFor([]),
            idleTimeout: IDLE_TIMEOUT,
            processStateEvent: noopProcess,
          })
        )
        yield* TestClock.adjust(IDLE_TIMEOUT)
        yield* Fiber.join(fiber)
        return yield* sm.summary
      })
    )

    // A quiet host with no tracked responses is a clean stop, not a failure.
    expect(summary).toEqual({ failed: [], cancelled: false })
    expect(spy.onErrorCalls).toHaveLength(0)
    expect(logs.some((l) => l.message.includes('still in-flight'))).toBe(false)
  })

  it('settles still-tracked responses as failures on idle timeout (settleInFlightAsFailures path)', async () => {
    const spy = makeSpy()
    const inFlightUrls = ['https://ehr.test/Patient/r1', 'https://ehr.test/Observation/r2']

    const { value: summary, logs } = await runWithTestClock(
      Effect.gen(function* () {
        const sm = yield* makeRunStateMachine(spy.setFailed, spy.onError)
        const fiber = yield* Effect.fork(
          runDriveLoop({
            stateMachine: sm,
            inProgressResponses: trackerFor(inFlightUrls),
            idleTimeout: IDLE_TIMEOUT,
            processStateEvent: noopProcess,
          })
        )
        yield* TestClock.adjust(IDLE_TIMEOUT)
        yield* Fiber.join(fiber)
        return yield* sm.summary
      })
    )

    // Every response left mid-stream at the timeout is surfaced as a
    // `response` failure rather than dropped — the loss shows up in `partial`.
    expect(summary.cancelled).toBe(false)
    expect(sortById(summary.failed)).toEqual(sortById(responseFailures(inFlightUrls)))
    // One `onError` per abandoned response, and the warning was logged.
    expect(spy.onErrorCalls).toHaveLength(inFlightUrls.length)
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('still in-flight'))).toBe(true)
  })

  it('surfaces exactly the in-flight responses as failures for any tracked set (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.webUrl(), { minLength: 1, maxLength: 6 }),
        async (urls) => {
          const spy = makeSpy()
          const { value: summary } = await runWithTestClock(
            Effect.gen(function* () {
              const sm = yield* makeRunStateMachine(spy.setFailed, spy.onError)
              const fiber = yield* Effect.fork(
                runDriveLoop({
                  stateMachine: sm,
                  inProgressResponses: trackerFor(urls),
                  idleTimeout: IDLE_TIMEOUT,
                  processStateEvent: () => Effect.void,
                })
              )
              yield* TestClock.adjust(IDLE_TIMEOUT)
              yield* Fiber.join(fiber)
              return yield* sm.summary
            })
          )

          expect(sortById(summary.failed)).toEqual(sortById(responseFailures(urls)))
          expect(spy.onErrorCalls).toHaveLength(urls.length)
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})
