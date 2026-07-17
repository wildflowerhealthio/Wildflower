// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers are typed as `any`; the unsafe-assignment lint fires on idiomatic `expect.objectContaining` nesting here

import { Chunk, Effect, MutableHashMap, Option, TestClock, TestContext } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SimpleEntity } from 'collector-fundamentals/test-helpers'
import {
  noopSendMessage,
  responseData,
  responseFinished,
  responseStart,
  type SimpleResources,
} from './collector-bridge-message-handler.test-helpers.ts'
import * as RunLifecycleState from './run-lifecycle-state.ts'
import { SETTLE_CONFIRM_WINDOW } from './run-lifecycle-state.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

/**
 * Direct coverage of the {@link RunLifecycleState} — the run's termination surface —
 * wired to a bare {@link SnifferResponseTracker} the way the composition wires them
 * (the composed-handler tests go through `makeSimpleHandler`). The
 * `stopAutomaticNavigation` hook is stubbed with a counter so the teardown path
 * can be asserted without a live navigation machine. Closing the results stream
 * (`handleSniffingComplete` / `abandonAllRequestSniffing`), the
 * {@link SETTLE_CONFIRM_WINDOW} straggler grace, and the "leaves the stream open"
 * guard (`cancelAllRequestSniffing`) all live here.
 *
 * The settle-close is a forked `TestClock`-driven daemon, so every test runs
 * inside one `Effect` program with `TestContext` and advances the clock by
 * {@link SETTLE_CONFIRM_WINDOW} to observe the close.
 */

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

interface Harness {
  readonly tracker: SnifferResponseTracker.SnifferResponseTracker<SimpleResources>
  readonly lifecycle: RunLifecycleState.RunLifecycleState<SimpleResources>
  readonly navigationStops: () => number
}

/**
 * Wire a tracker and lifecycle exactly as the composition does — the tracker
 * publishes into the lifecycle's stream, the lifecycle reads the tracker's
 * incomplete-request state — with `stopAutomaticNavigation` replaced by a counter.
 */
const makeHarness = (): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    let stopCount = 0
    const tracker: SnifferResponseTracker.SnifferResponseTracker<SimpleResources> =
      yield* SnifferResponseTracker.make<SimpleResources>({
        matchEntity: (url) => Option.fromNullable([SimpleEntity].find((e) => e.isFoundAt(url))),
        sendMessage: noopSendMessage,
        handleNewSniffResult: (result) => lifecycle.handleNewSniffResult(result),
      })
    const lifecycle: RunLifecycleState.RunLifecycleState<SimpleResources> =
      yield* RunLifecycleState.make<SimpleResources>({
        hasIncompleteSniffedRequests: tracker.hasIncompleteSniffedRequests,
        failIncompleteSniffedRequests: tracker.failIncompleteSniffedRequests,
        cancelIncompleteSniffedRequests: tracker.cancelIncompleteSniffedRequests,
        stopAutomaticNavigation: () =>
          Effect.sync(() => {
            stopCount += 1
          }),
      })
    return {
      tracker,
      lifecycle,
      navigationStops: () => stopCount,
    }
  })

const runTest = <A>(program: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

/** `None` once the results stream is finished *and* drained. */
const isDone = (harness: Harness): Effect.Effect<boolean> =>
  Effect.map(harness.lifecycle.requestSniffingResults.size, Option.isNone)

/** Synchronously take everything currently queued on the results stream. */
const drain = (
  harness: Harness
): Effect.Effect<ReadonlyArray<SnifferResponseTracker.SniffResult<SimpleResources>>> =>
  Effect.map(harness.lifecycle.requestSniffingResults.clear, Chunk.toReadonlyArray)

// Advance past the settle window so the forked settle-close daemon fires.
const passSettleWindow = TestClock.adjust(SETTLE_CONFIRM_WINDOW).pipe(
  Effect.andThen(Effect.yieldNow())
)

describe('RunLifecycleState completion (closing requestSniffingResults)', () => {
  it('closes the stream after a settle window when sniffing completes with nothing incomplete', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        expect(yield* isDone(harness)).toBe(false)

        yield* harness.lifecycle.handleSniffingComplete
        // The settle-close is armed, not fired: the stream stays open until the
        // window elapses (so a straggler ResponseStart still has a chance).
        expect(yield* isDone(harness)).toBe(false)

        yield* passSettleWindow
        expect(yield* isDone(harness)).toBe(true)
      })
    ))

  it('defers the close until the last incomplete request settles after sniff-complete', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )

        // Sniffing is done but r1 is still incomplete: the stream must stay open,
        // and no settle is even armed yet.
        yield* harness.lifecycle.handleSniffingComplete
        yield* passSettleWindow
        expect(yield* isDone(harness)).toBe(false)

        yield* tracker.handleResponseData(
          responseData('r1', JSON.stringify({ name: 'Al', age: 1 }))
        )
        yield* tracker.handleResponseFinished(responseFinished('r1'))
        // r1's result is queued; the settle-close is now armed but not yet fired.
        expect(yield* isDone(harness)).toBe(false)

        yield* passSettleWindow
        const results = yield* drain(harness)
        expect(results).toHaveLength(1)
        expectRightToEqual(results[0], [{ name: 'Al', age: 1 }])
        expect(yield* isDone(harness)).toBe(true)
      })
    ))

  it('keeps the stream open for a straggler ResponseStart arriving during the settle window (issue: late response drop)', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness

        // r1 finishes after sniff-complete → quiescent → settle-close armed.
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* harness.lifecycle.handleSniffingComplete
        yield* tracker.handleResponseData(
          responseData('r1', JSON.stringify({ name: 'Al', age: 1 }))
        )
        yield* tracker.handleResponseFinished(responseFinished('r1'))

        // A late request arrives *during* the settle window — the shims are still
        // live post-SniffingComplete. It re-populates the incomplete map before
        // the window elapses.
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )

        // Window elapses: the daemon re-confirms, sees r2 incomplete, does NOT
        // close. The straggler is preserved instead of being dropped.
        yield* passSettleWindow
        expect(yield* isDone(harness)).toBe(false)
        expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(1)

        // r2 settles → re-arms → closes. Both results are delivered.
        yield* tracker.handleResponseData(
          responseData('r2', JSON.stringify({ name: 'Bo', age: 2 }))
        )
        yield* tracker.handleResponseFinished(responseFinished('r2'))
        yield* passSettleWindow

        const results = yield* drain(harness)
        expect(results).toHaveLength(2)
        const parsed = results.map((r) =>
          r._tag === 'Right' ? r.right : expect.fail('expected a Right result')
        )
        expect(parsed).toEqual([[{ name: 'Al', age: 1 }], [{ name: 'Bo', age: 2 }]])
        expect(yield* isDone(harness)).toBe(true)
      })
    ))

  it('abandonAllRequestSniffing publishes every incomplete request as a Left failure, then closes', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )

        yield* harness.lifecycle.abandonAllRequestSniffing

        const results = yield* drain(harness)
        expect(results).toHaveLength(2)
        const urls = results.map((r) =>
          r._tag === 'Left' ? r.left.url : expect.fail('expected a Left failure')
        )
        expect(new Set(urls)).toEqual(
          new Set(['https://example.com/people/1', 'https://example.com/people/2'])
        )
        for (const r of results) {
          expectLeftToEqual(
            r,
            expect.objectContaining({
              error: expect.objectContaining({ _tag: 'UnknownException' }),
            })
          )
        }
        expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(0)
        expect(yield* isDone(harness)).toBe(true)
      })
    ))
})

describe('RunLifecycleState teardown (leaves the stream open)', () => {
  it('cancelAllRequestSniffing stops navigation, drops incomplete requests, and does not close the stream', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )
        expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(2)

        yield* harness.lifecycle.cancelAllRequestSniffing(noopSendMessage)

        // Navigation stopped, incomplete requests cancelled + dropped, stream open.
        expect(harness.navigationStops()).toBe(1)
        expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(0)
        expect(yield* drain(harness)).toHaveLength(0)
        expect(yield* isDone(harness)).toBe(false)
      })
    ))
})
