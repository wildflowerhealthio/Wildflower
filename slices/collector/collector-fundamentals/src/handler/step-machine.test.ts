// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment / unsafe-destructure lint fires on idiomatic `mock.calls[0]` access here

import { Duration, Effect, Layer, TestClock, TestContext } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { type Link, UrlMatch } from 'collector-fundamentals/model'
import {
  adapterLayer,
  makeSimpleHandler,
  pageLoaded,
  type SimpleHandlerArgs,
} from './collector-bridge-message-handler.test-helpers.ts'

describe('CollectorBridgeMessageHandler.make: step machine', () => {
  describe('PageLoaded', () => {
    /**
     * Fixtures for the step-driver suite. `Link.Open` carries a
     * `WebViewSource.Any`; the test only inspects the dispatched
     * `Open` bridge payload so the `Uri` variant is plenty.
     */
    const linkA: Link.Any = {
      _tag: 'Open',
      source: { _tag: 'Uri', uri: 'https://example.com/a' },
    }
    const linkB: Link.Any = {
      _tag: 'Open',
      source: { _tag: 'Uri', uri: 'https://example.com/b' },
    }
    const fillLink: Link.Any = {
      _tag: 'Fill',
      querySelector: '#username',
      value: 'alice',
    }
    // A step gated on landing at `…/dashboard`, timing out after 30s.
    const dashboardPattern = UrlMatch.make({ segments: [UrlMatch.literal('dashboard')] })
    const urlMatchLink: Link.Any = {
      _tag: 'Open',
      source: { _tag: 'Uri', uri: 'https://example.com/next' },
      advanceWhen: { _tag: 'UrlMatch', pattern: dashboardPattern, timeout: Duration.seconds(30) },
    }

    it('dispatches SniffingComplete after stepDelay when linkSequence is empty', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({ sendMessage, linkSequence: [] })

          yield* handler.PageLoaded(pageLoaded())
          // Before the timer fires, nothing has been dispatched.
          expect(sendMessage).not.toHaveBeenCalled()

          yield* TestClock.adjust(Duration.seconds(5))
          // Yield once so the daemon's tail (sendMessage → state update)
          // makes it past the test runtime's microtask boundary.
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledOnce()
          expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('dispatches each link in order, separated by stepDelay, then SniffingComplete', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            linkSequence: [linkA, linkB],
          })

          // PageLoaded #1 (initial) → schedules linkA.
          yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/' }))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual({
            _tag: 'Open',
            source: linkA.source,
          })

          // PageLoaded #2 (after linkA's nav) → schedules linkB.
          yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/a' }))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual({
            _tag: 'Open',
            source: linkB.source,
          })

          // PageLoaded #3 (after linkB's nav) → linkSequence exhausted → SniffingComplete.
          yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/b' }))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(3)
          expect(sendMessage.mock.calls[2][0]).toEqual({ _tag: 'SniffingComplete' })
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('a second PageLoaded during the wait interrupts the pending timer and re-arms for the same index', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            linkSequence: [linkA, linkB],
          })

          yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/' }))
          // Partial advance — not enough to fire.
          yield* TestClock.adjust(Duration.seconds(3))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()

          // Fresh PageLoaded re-arms the timer with the SAME current index (linkA).
          yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/' }))
          yield* TestClock.adjust(Duration.seconds(3))
          yield* Effect.yieldNow()
          // Still not enough on the fresh timer (only 3s of the new 5s elapsed).
          expect(sendMessage).not.toHaveBeenCalled()

          yield* TestClock.adjust(Duration.seconds(2))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual({
            _tag: 'Open',
            source: linkA.source,
          })
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('warns and no-ops on PageLoaded after SniffingComplete has fired', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({ sendMessage, linkSequence: [] })

          // Drive to 'done'.
          yield* handler.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledOnce()

          // Subsequent PageLoaded should warn and dispatch nothing.
          yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/next' })).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toEqual([
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining(
                    'CollectorBridgeMessageHandler.PageLoaded: handler is done'
                  ),
                }),
              ])
            }),
            Effect.scoped
          )

          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          // Still only the one SniffingComplete from earlier.
          expect(sendMessage).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('clear() interrupts the pending step timer', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            linkSequence: [linkA],
          })

          yield* handler.PageLoaded(pageLoaded())
          yield* handler.clear()
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('cancelAllInFlight interrupts the pending step timer', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            linkSequence: [linkA],
          })

          yield* handler.PageLoaded(pageLoaded())
          yield* handler.cancelAllInFlight(() => Effect.void)
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('clear() resets the index so subsequent PageLoadeds restart from linkSequence[0]', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            linkSequence: [linkA, linkB],
          })

          // Advance to linkA dispatched, then linkB pending.
          yield* handler.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)

          yield* handler.clear()

          // Fresh sequence after clear: PageLoaded → linkA again, not linkB.
          yield* handler.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual({
            _tag: 'Open',
            source: linkA.source,
          })
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('dispatches a Fill step verbatim (minus advanceWhen) after stepDelay', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
          const handler = makeSimpleHandler({ sendMessage, linkSequence: [fillLink] })

          yield* handler.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()

          expect(sendMessage).toHaveBeenCalledTimes(1)
          // The wire message is the Fill payload with no plan-only `advanceWhen`.
          expect(sendMessage.mock.calls[0][0]).toEqual({
            _tag: 'Fill',
            querySelector: '#username',
            value: 'alice',
          })
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    describe('advanceWhen: UrlMatch', () => {
      it('holds the step until a matching PageLoaded, then dispatches after stepDelay', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
            const handler = makeSimpleHandler({ sendMessage, linkSequence: [urlMatchLink] })

            // A non-matching PageLoaded parks the step; the settle timer never
            // even starts, so advancing past stepDelay dispatches nothing.
            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/login' }))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()

            // A matching PageLoaded starts the settle timer; after stepDelay the
            // step dispatches (advanceWhen is stripped from the wire message).
            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/dashboard' }))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual({
              _tag: 'Open',
              source: urlMatchLink.source,
            })
          }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
        ))

      it('aborts via SniffingComplete when no matching PageLoaded arrives within the timeout', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
            const handler = makeSimpleHandler({ sendMessage, linkSequence: [urlMatchLink] })

            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/login' }))
            // Before the 30s timeout, nothing has been dispatched.
            yield* TestClock.adjust(Duration.seconds(29))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()

            // The timeout fires → SniffingComplete, and the machine is Done.
            yield* TestClock.adjust(Duration.seconds(1))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })

            // A later PageLoaded is warned + dropped (Done is terminal).
            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/dashboard' })).pipe(
              LoggingLayerTest.expectToLog((logs) => {
                expect(logs).toEqual([
                  expect.objectContaining({
                    level: 'WARN',
                    message: expect.stringContaining(
                      'CollectorBridgeMessageHandler.PageLoaded: handler is done'
                    ),
                  }),
                ])
              }),
              Effect.scoped
            )
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
          }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
        ))

      it('a matching PageLoaded before the timeout cancels the abort', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
            const handler = makeSimpleHandler({ sendMessage, linkSequence: [urlMatchLink] })

            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/login' }))
            yield* TestClock.adjust(Duration.seconds(10))
            yield* Effect.yieldNow()

            // Match arrives → timeout fiber interrupted, settle timer scheduled.
            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/dashboard' }))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual({
              _tag: 'Open',
              source: urlMatchLink.source,
            })

            // Advancing well past the original 30s deadline fires nothing more:
            // the timeout that would have aborted the run was cancelled.
            yield* TestClock.adjust(Duration.seconds(60))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
          }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
        ))

      it('clear() interrupts a pending URL-match timeout', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
            const handler = makeSimpleHandler({ sendMessage, linkSequence: [urlMatchLink] })

            yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/login' }))
            yield* handler.clear()
            yield* TestClock.adjust(Duration.seconds(30))
            yield* Effect.yieldNow()
            // No SniffingComplete abort — the timeout fiber was interrupted.
            expect(sendMessage).not.toHaveBeenCalled()
          }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
        ))
    })
  })
})
