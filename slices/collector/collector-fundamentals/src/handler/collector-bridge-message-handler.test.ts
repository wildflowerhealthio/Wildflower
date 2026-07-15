import { Duration, Effect, Layer, MutableHashMap, TestClock, TestContext } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { type Link } from 'collector-fundamentals/model'
import {
  adapterLayer,
  makeSimpleHandler,
  pageLoaded,
  responseStart,
  type SimpleHandlerArgs,
} from './collector-bridge-message-handler.test-helpers.ts'

/**
 * Cross-machine integration: `make` composes the response tracker and the
 * step machine into one surface, and `clear` / `cancelAllInFlight` fold
 * both machines' contributions into a single call. The per-machine
 * behaviour is covered in `response-tracker.test.ts` /
 * `step-machine.test.ts`; these cases pin only the composition seam — that
 * one call reaches *both* halves.
 */
describe('CollectorBridgeMessageHandler.make: composition', () => {
  const linkA: Link.Step = {
    action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/a' } },
  }

  it('clear() drops tracked responses AND interrupts the pending step timer in one call', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const handler = makeSimpleHandler({ sendMessage, linkSequence: [linkA] })

        // Response tracker: two tracked in-flight responses.
        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.ResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )
        // Step machine: a settle timer armed for linkA.
        yield* handler.PageLoaded(pageLoaded())
        expect(MutableHashMap.size(handler.inProgressResponses)).toBe(2)

        yield* handler.clear()

        // Tracker half: both tracked responses dropped.
        expect(MutableHashMap.size(handler.inProgressResponses)).toBe(0)

        // Step-machine half: the interrupted timer never dispatches linkA.
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage).not.toHaveBeenCalled()
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('cancelAllInFlight emits a CancelSnifferRequest per tracked id AND interrupts the pending step timer', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const cancelSend = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const handler = makeSimpleHandler({ sendMessage, linkSequence: [linkA] })

        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.ResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )
        yield* handler.PageLoaded(pageLoaded())

        yield* handler.cancelAllInFlight(cancelSend)

        // Tracker half: one CancelSnifferRequest dispatched per tracked id.
        expect(cancelSend).toHaveBeenCalledTimes(2)
        const messages = cancelSend.mock.calls.map((call) => call[0])
        expect(messages).toEqual(
          expect.arrayContaining([
            { _tag: 'CancelSnifferRequest', id: 'r1' },
            { _tag: 'CancelSnifferRequest', id: 'r2' },
          ])
        )

        // Step-machine half: the interrupted timer never dispatches linkA.
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage).not.toHaveBeenCalled()
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))
})
