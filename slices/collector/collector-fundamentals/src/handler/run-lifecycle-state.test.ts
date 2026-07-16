// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers are typed as `any`; the unsafe-assignment lint fires on idiomatic `expect.objectContaining` nesting here

import { Effect, MutableHashMap, Option } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SimpleEntity } from 'collector-fundamentals/test-helpers'
import {
  drainResults,
  noopSendMessage,
  responseData,
  responseFinished,
  responseStart,
  runHandlerSync,
  type SimpleResources,
} from './collector-bridge-message-handler.test-helpers.ts'
import * as RunLifecycleState from './run-lifecycle-state.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

/**
 * Direct coverage of the {@link RunLifecycleState} — the run's termination surface —
 * wired to a bare {@link SnifferResponseTracker} the way the composition wires them
 * (the composed-handler tests go through `makeSimpleHandler`). The
 * `stopAutomaticNavigation` hook is stubbed with a counter so the teardown path
 * can be asserted without a live navigation machine. Closing the results stream
 * (`markSniffingComplete` / `abandonAllRequestSniffing`) and the "leaves the
 * stream open" guard (`cancelAllRequestSniffing`) all live here.
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
const makeHarness = (): Harness =>
  Effect.runSync(
    Effect.gen(function* () {
      let stopCount = 0
      const tracker: SnifferResponseTracker.SnifferResponseTracker<SimpleResources> =
        yield* SnifferResponseTracker.make<SimpleResources>({
          matchEntity: (url) => Option.fromNullable([SimpleEntity].find((e) => e.isFoundAt(url))),
          sendMessage: noopSendMessage,
          publishSniffResult: (result) => lifecycle.publishSniffResult(result),
          endRequestSniffingResultsUnlessMoreExpected: Effect.suspend(
            () => lifecycle.endRequestSniffingResultsUnlessMoreExpected
          ),
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
  )

/** `None` once the results stream is finished *and* drained. */
const resultsDone = (lifecycle: RunLifecycleState.RunLifecycleState<SimpleResources>): boolean =>
  Option.isNone(Effect.runSync(lifecycle.requestSniffingResults.size))

describe('RunLifecycleState completion (closing requestSniffingResults)', () => {
  it('closes the stream immediately when sniffing completes with nothing incomplete', () => {
    const { lifecycle } = makeHarness()
    expect(resultsDone(lifecycle)).toBe(false)

    Effect.runSync(lifecycle.markSniffingComplete)

    expect(resultsDone(lifecycle)).toBe(true)
  })

  it('defers the close until the last incomplete request settles after sniff-complete', () => {
    const { tracker, lifecycle } = makeHarness()
    runHandlerSync(
      tracker.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )

    // Sniffing is done but r1 is still incomplete: the stream must stay open.
    Effect.runSync(lifecycle.markSniffingComplete)
    expect(resultsDone(lifecycle)).toBe(false)

    runHandlerSync(tracker.ResponseData(responseData('r1', JSON.stringify({ name: 'Al', age: 1 }))))
    runHandlerSync(tracker.ResponseFinished(responseFinished('r1')))

    // r1's result is queued and the stream is now closed: drain it, then done.
    const results = drainResults(lifecycle)
    expect(results).toHaveLength(1)
    expectRightToEqual(results[0], [{ name: 'Al', age: 1 }])
    expect(resultsDone(lifecycle)).toBe(true)
  })

  it('abandonAllRequestSniffing publishes every incomplete request as a Left failure, then closes', () => {
    const { tracker, lifecycle } = makeHarness()
    runHandlerSync(
      tracker.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(
      tracker.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
    )

    Effect.runSync(lifecycle.abandonAllRequestSniffing)

    const results = drainResults(lifecycle)
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
        expect.objectContaining({ error: expect.objectContaining({ _tag: 'UnknownException' }) })
      )
    }
    expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(0)
    expect(resultsDone(lifecycle)).toBe(true)
  })
})

describe('RunLifecycleState teardown (leaves the stream open)', () => {
  it('cancelAllRequestSniffing stops navigation, drops incomplete requests, and does not close the stream', () => {
    const harness = makeHarness()
    const { tracker, lifecycle } = harness
    runHandlerSync(
      tracker.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(
      tracker.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
    )
    expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(2)

    Effect.runSync(lifecycle.cancelAllRequestSniffing(noopSendMessage))

    // Navigation stopped, incomplete requests cancelled + dropped, stream open.
    expect(harness.navigationStops()).toBe(1)
    expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(0)
    expect(drainResults(lifecycle)).toHaveLength(0)
    expect(resultsDone(lifecycle)).toBe(false)
  })
})
