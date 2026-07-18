import { Duration, Effect, Layer, MutableHashMap, Option, TestClock, TestContext } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { type Step } from 'collector-fundamentals/model'
import {
  adapterLayer,
  makeSimpleHandler,
  matchesFound,
  pageLoaded,
  responseStart,
  type SimpleHandlerArgs,
} from './collector-bridge-message-handler.test-helpers.ts'
import { SETTLE_CONFIRM_WINDOW } from './run-lifecycle-state.ts'

/**
 * Cross-machine integration: `make` composes the response tracker, the
 * automatic-navigation machine, and the run lifecycle into one surface.
 * `cancelAllRequestSniffing` folds both machines' teardown into a single call,
 * and the automatic-navigation machine's terminal `SniffingComplete` reaches the
 * lifecycle through the `onSniffingComplete` hook. The per-part behaviour is
 * covered in `sniffer-response-tracker.test.ts` / `automatic-navigation.test.ts`
 * / `run-lifecycle-state.test.ts`;
 * these cases pin only the composition seams — that one call, or one event,
 * reaches *both* halves.
 */
describe('CollectorBridgeMessageHandler.make: composition', () => {
  const linkA: Step.Step = {
    action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/a' } },
  }

  it('cancelAllRequestSniffing sends a CancelSnifferRequest per incomplete id, drops them, AND stops the automatic navigation', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const cancelSend = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const handler = makeSimpleHandler({ sendMessage, stepSequence: [linkA] })

        // Response tracker: two incomplete sniffed requests.
        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.ResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )
        // Automatic navigation: a settle timer armed for linkA.
        yield* handler.PageLoaded(pageLoaded())
        expect(MutableHashMap.size(handler.incompleteSniffedRequests)).toBe(2)

        yield* handler.cancelAllRequestSniffing(cancelSend)

        // Tracker half: one CancelSnifferRequest per id, then all dropped.
        expect(cancelSend).toHaveBeenCalledTimes(2)
        const messages = cancelSend.mock.calls.map((call) => call[0])
        expect(messages).toEqual(
          expect.arrayContaining([
            { _tag: 'CancelSnifferRequest', id: 'r1' },
            { _tag: 'CancelSnifferRequest', id: 'r2' },
          ])
        )
        expect(MutableHashMap.size(handler.incompleteSniffedRequests)).toBe(0)

        // Automatic-navigation half: the interrupted timer never dispatches linkA.
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage).not.toHaveBeenCalled()
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('the onSniffingComplete hook closes requestSniffingResults when the step sequence is exhausted', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const handler = makeSimpleHandler({ stepSequence: [] })
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(false)

        // Empty sequence: the first PageLoaded arms the settle timer, which fires
        // `SniffingComplete` → the lifecycle's `handleSniffingComplete` hook. With
        // nothing incomplete, that arms the settle-close; after the settle window
        // elapses the stream is closed end-to-end.
        yield* handler.PageLoaded(pageLoaded())
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        // Still open until the settle window passes (a straggler could re-open it).
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(false)

        yield* TestClock.adjust(SETTLE_CONFIRM_WINDOW)
        yield* Effect.yieldNow()
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('routes MatchesFound into the automatic navigation, whose terminal SniffingComplete closes the stream', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        // A ForEach whose body is empty; over zero matches it collapses to the
        // terminal, so this pins the MatchesFound→machine→SniffingComplete→close
        // seam end-to-end through the composed handler.
        const forEachStep: Step.Step = {
          _tag: 'ForEach',
          discover: { querySelector: '.detail', timeout: Duration.seconds(10) },
          body: () => [],
        }
        const handler = makeSimpleHandler({ sendMessage, stepSequence: [forEachStep] })

        // List settles → the composed handler forwards a QueryMatches.
        yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/list' }))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        const first = sendMessage.mock.calls[0]?.[0]
        if (first === undefined || first._tag !== 'QueryMatches') {
          throw new Error(`expected a QueryMatches, got ${JSON.stringify(first)}`)
        }
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(false)

        // The MatchesFound answer, routed through the composed handler, reaches
        // the machine: an empty result skips the fan-out and completes the run.
        yield* handler.MatchesFound(matchesFound(first.queryId, []))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls.at(-1)?.[0]).toEqual({ _tag: 'SniffingComplete' })

        // The terminal SniffingComplete drives the lifecycle's close-check.
        yield* TestClock.adjust(SETTLE_CONFIRM_WINDOW)
        yield* Effect.yieldNow()
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))
})
