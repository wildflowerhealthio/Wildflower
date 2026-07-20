// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers are typed as `any`; the unsafe-assignment lint fires on idiomatic `expect.objectContaining` nesting here

import { Chunk, Effect, MutableHashMap, Option } from 'effect'
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
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

/**
 * Direct coverage of the {@link RunLifecycleState} — the run's termination surface —
 * wired to a bare {@link SnifferResponseTracker} the way the composition wires them
 * (the composed-handler tests go through `makeSimpleHandler`).
 *
 * Two hooks are stubbed to stand in for the automatic-navigation machine:
 * `stopAutomaticNavigation` increments a counter, and `signalNoMoreResultsExpected`
 * models the machine's response to "no more results" — it records the signal and,
 * when the harness's `drained` flag is set (the machine's queue is empty), fires
 * `handleSniffingComplete` just as `Drained + NoMoreResultsExpected → Done →
 * SniffingComplete` would. Completion is thus the queue-drained ∧ requests-settled
 * coupling, with no settle window (that grace is gone; plans use trailing `Delay`s).
 */

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

interface Harness {
  readonly tracker: SnifferResponseTracker.SnifferResponseTracker<SimpleResources>
  readonly lifecycle: RunLifecycleState.RunLifecycleState<SimpleResources>
  readonly navigationStops: () => number
  readonly noMoreResultsSignals: () => number
  /** Model the machine's queue-drained state so a `signal` can complete the run. */
  readonly setDrained: (value: boolean) => void
}

const makeHarness = (): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    let stopCount = 0
    let signalCount = 0
    const drained = { value: false }
    const tracker: SnifferResponseTracker.SnifferResponseTracker<SimpleResources> =
      yield* SnifferResponseTracker.make<SimpleResources>({
        matchEntity: (url) => Option.fromNullable([SimpleEntity].find((e) => e.isFoundAt(url))),
        sendMessage: noopSendMessage,
        handleNewSniffResult: (result) => lifecycle.handleNewSniffResult(result),
        handleGeneratedSteps: () => Effect.void,
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
        // The machine: on "no more results", complete iff the queue is drained.
        signalNoMoreResultsExpected: Effect.gen(function* () {
          signalCount += 1
          if (drained.value) yield* lifecycle.handleSniffingComplete
        }),
      })
    return {
      tracker,
      lifecycle,
      navigationStops: () => stopCount,
      noMoreResultsSignals: () => signalCount,
      setDrained: (value) => {
        drained.value = value
      },
    }
  })

const runTest = <A>(program: Effect.Effect<A>): Promise<A> => Effect.runPromise(program)

/** `None` once the results stream is finished *and* drained. */
const isDone = (harness: Harness): Effect.Effect<boolean> =>
  Effect.map(harness.lifecycle.requestSniffingResults.size, Option.isNone)

/** Synchronously take everything currently queued on the results stream. */
const drain = (
  harness: Harness
): Effect.Effect<ReadonlyArray<SnifferResponseTracker.SniffResult<SimpleResources>>> =>
  Effect.map(harness.lifecycle.requestSniffingResults.clear, Chunk.toReadonlyArray)

/** Settle a tracked request `id` with a valid person body. */
const settle = (
  harness: Harness,
  id: string,
  person: { name: string; age: number }
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* harness.tracker.handleResponseData(responseData(id, JSON.stringify(person)))
    yield* harness.tracker.handleResponseFinished(responseFinished(id))
  })

describe('RunLifecycleState completion (closing requestSniffingResults)', () => {
  it('signals the machine and closes when the queue drains onto an empty request map', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        harness.setDrained(true)
        expect(yield* isDone(harness)).toBe(false)

        // The machine's `onDrained` hook is wired to this exact effect.
        yield* harness.lifecycle.endRequestSniffingResultsUnlessMoreExpected

        expect(harness.noMoreResultsSignals()).toBe(1)
        expect(yield* isDone(harness)).toBe(true)
      })
    ))

  it('defers completion until the last incomplete request settles', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness
        harness.setDrained(true)
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )

        // Queue drained, but r1 is still incomplete: no signal, no close.
        yield* harness.lifecycle.endRequestSniffingResultsUnlessMoreExpected
        expect(harness.noMoreResultsSignals()).toBe(0)
        expect(yield* isDone(harness)).toBe(false)

        // r1 settles → the end-check signals → (drained) completes → closes.
        yield* settle(harness, 'r1', { name: 'Al', age: 1 })
        expect(harness.noMoreResultsSignals()).toBe(1)
        const results = yield* drain(harness)
        expect(results).toHaveLength(1)
        expectRightToEqual(results[0], [{ name: 'Al', age: 1 }])
        expect(yield* isDone(harness)).toBe(true)
      })
    ))

  it('signals but does not close when the request map empties while the queue is not drained', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness
        // The machine is still navigating (queue not drained).
        harness.setDrained(false)
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )

        yield* settle(harness, 'r1', { name: 'Al', age: 1 })

        // The map emptied, so the machine was told — but it isn't drained, so the
        // run continues (more steps to dispatch) and the stream stays open.
        expect(harness.noMoreResultsSignals()).toBe(1)
        expect(yield* isDone(harness)).toBe(false)
      })
    ))

  it('a url-match-timeout abort with a request still in flight defers the close to the last settle', () =>
    runTest(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const { tracker } = harness
        yield* tracker.handleResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )

        // The machine reached `Done` via a url-match-timeout abort (not via a
        // signal) while r1 is still in flight: Gate A is set, but the stream must
        // stay open so r1's result still drains.
        yield* harness.lifecycle.handleSniffingComplete
        expect(yield* isDone(harness)).toBe(false)

        // r1 settles → end-check → Gate A already set → close.
        yield* settle(harness, 'r1', { name: 'Al', age: 1 })
        const results = yield* drain(harness)
        expect(results).toHaveLength(1)
        expectRightToEqual(results[0], [{ name: 'Al', age: 1 }])
        expect(yield* isDone(harness)).toBe(true)
      })
    ))

  it('abandonAllRequestSniffing stops the machine, publishes every incomplete request as a Left, then closes', () =>
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

        // The machine is stopped so a parked `Delay` timer can't leak.
        expect(harness.navigationStops()).toBe(1)
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
