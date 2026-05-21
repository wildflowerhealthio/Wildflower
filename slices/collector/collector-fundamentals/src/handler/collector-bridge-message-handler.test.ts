// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment / unsafe-destructure lint fires on idiomatic `mock.calls[0]` access here

import type { CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Duration, Effect, Encoding, Layer, MutableHashMap, TestClock, TestContext } from 'effect'
import { BareSender } from 'effect-messaging-core'
import { LoggingLayerTest, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { EntityDefinition, type Link, ScrapingPlan } from 'collector-fundamentals/model'
import { AnotherEntity, SimpleEntity } from 'collector-fundamentals/test-helpers'
import * as CollectorBridgeMessageHandler from './collector-bridge-message-handler.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

type SimpleResources = { name: string; age: number }
type SimpleHandlerArgs = Parameters<typeof CollectorBridgeMessageHandler.make<SimpleResources>>[0]

const noopSendMessage: SimpleHandlerArgs['sendMessage'] = () => Effect.void

/**
 * Bridge handlers carry a `BareSender` requirement so they can call
 * `bridge.send(...)`; the dispatch fiber discharges this at runtime.
 * Tests that invoke handlers directly thread a no-op via this pipe-
 * style provider.
 */
const provideNoopBareSender = Effect.provide(
  Layer.succeed(BareSender, { bareSender: () => Effect.void })
)

/** Run a handler effect synchronously with the no-op `BareSender`. */
const runHandler = <A>(effect: Effect.Effect<A, never, BareSender>): A =>
  Effect.runSync(effect.pipe(provideNoopBareSender))

/**
 * Build a handler bound to a single-entity plan (`SimpleEntity` only).
 * Most tests only care about one entity; the few that want overlapping or
 * multi-entity setups build the plan inline.
 */
const makeSimpleHandler = (
  overrides: Partial<SimpleHandlerArgs> & {
    readonly linkSequence?: readonly Link.Any[]
    readonly stepDelay?: Duration.Duration
  } = {}
): Effect.Effect.Success<
  ReturnType<typeof CollectorBridgeMessageHandler.make<SimpleResources>>
> => {
  const { linkSequence, stepDelay, ...rest } = overrides
  return Effect.runSync(
    CollectorBridgeMessageHandler.make({
      scrapingPlan: ScrapingPlan.make<SimpleResources>({
        name: 'TestPlan',
        entityDefinitions: [SimpleEntity],
        firstPage: { _tag: 'Uri', uri: 'https://example.com/' },
        linkSequence: linkSequence ?? [],
        stepDelay: stepDelay ?? Duration.seconds(5),
      }),
      sendMessage: noopSendMessage,
      onResult: () => undefined,
      ...rest,
    })
  )
}

type Handler = Effect.Effect.Success<
  ReturnType<typeof CollectorBridgeMessageHandler.make<SimpleResources>>
>
type StartArg = Parameters<Handler['ResponseStart']>[0]
type DataArg = Parameters<Handler['ResponseData']>[0]
type FinishArg = Parameters<Handler['ResponseFinished']>[0]
type ErrorArg = Parameters<Handler['RequestError']>[0]
type CancelledArg = Parameters<Handler['Cancelled']>[0]
type PageLoadedArg = Parameters<Handler['PageLoaded']>[0]

const responseStart = (overrides: { id: string; url: string }): StartArg => ({
  _tag: 'ResponseStart',
  status: 200,
  statusText: 'OK',
  headers: [],
  ...overrides,
})

const responseData = (id: string, body: string): DataArg => ({
  _tag: 'ResponseData',
  id,
  // The wire schema for `data` is a base64 `string` (see browser-sniffer-core
  // `ResponseDataMessage`); the handler decodes via `Encoding.decodeBase64`.
  data: Encoding.encodeBase64(encoder.encode(body)),
})

const responseFinished = (id: string): FinishArg => ({ _tag: 'ResponseFinished', id })

const requestError = (overrides: { id: string; url: string; message: string }): ErrorArg => ({
  _tag: 'RequestError',
  ...overrides,
})

const cancelled = (id: string): CancelledArg => ({ _tag: 'Cancelled', id })

const pageLoaded = (overrides: { url?: string; pageContentId?: string } = {}): PageLoadedArg => ({
  _tag: 'PageLoaded',
  url: overrides.url ?? 'https://example.com/',
  pageContentId: overrides.pageContentId ?? 'page-1',
})

describe('CollectorBridgeMessageHandler.make', () => {
  describe('ResponseStart', () => {
    it('begins tracking when the URL matches some entity', () => {
      const sendMessage = vi.fn(noopSendMessage)
      const handler = makeSimpleHandler({ sendMessage })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/42' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r1')
    })

    it('cancels via sendMessage when no entity matches', () => {
      const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
      const handler = makeSimpleHandler({ sendMessage })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/unknown' }))
      )

      expect(sendMessage).toHaveBeenCalledOnce()
      expect(sendMessage.mock.calls[0][0]).toEqual({
        _tag: 'CancelSnifferRequest',
        id: 'r2',
      } satisfies typeof CancelSnifferRequestMessage.Type)
      expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r2')
    })

    it('matches against any of the configured entities', () => {
      type MultiResources = SimpleResources | { id: string }
      const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
      const handler = Effect.runSync(
        CollectorBridgeMessageHandler.make<MultiResources>({
          scrapingPlan: ScrapingPlan.make<MultiResources>({
            name: 'MultiPlan',
            // Each entity is `EntityDefinition<X>` with `X ⊂ MultiResources`; widen
            // the array to the union so the array literal typechecks.
            entityDefinitions: [
              SimpleEntity,
              AnotherEntity,
            ] as readonly EntityDefinition.EntityDefinition<MultiResources>[],
            firstPage: { _tag: 'Uri', uri: 'https://example.com/' },
            linkSequence: [],
            stepDelay: Duration.seconds(5),
          }),
          sendMessage,
          onResult: () => undefined,
        })
      )

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/items/abc' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r1')
      expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r2')
    })
  })

  describe('ResponseData', () => {
    it('appends a base64-decoded chunk to a tracked response', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(handler.ResponseData(responseData('r1', '{"name":"Bob"')))
      runHandler(handler.ResponseData(responseData('r1', ',"age":25}')))
      runHandler(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      expectRightToEqual(onResult.mock.calls[0][0].result, [{ name: 'Bob', age: 25 }])
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      await Effect.runPromise(
        handler.ResponseData(responseData('unknown', 'data')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.ResponseData: no tracked response for id unknown'
                ),
              }),
            ])
          }),
          Effect.scoped,

          provideNoopBareSender
        )
      )
      expect(onResult).not.toHaveBeenCalled()
    })

    it('emits onResult Left(UnknownException) and drops the entry when base64 decode fails on a tracked response', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(
        handler.ResponseData({ _tag: 'ResponseData', id: 'r1', data: '!!! not base64 !!!' })
      )

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/1')
      expectLeftToEqual(result, expect.objectContaining({ _tag: 'UnknownException' }))
      // The tracked entry is removed so a subsequent ResponseFinished
      // becomes a no-op rather than a duplicate onResult.
      expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r1')
      runHandler(handler.ResponseFinished(responseFinished('r1')))
      expect(onResult).toHaveBeenCalledOnce()
    })
  })

  describe('ResponseFinished', () => {
    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      await Effect.runPromise(
        handler.ResponseFinished(responseFinished('unknown')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.ResponseFinished: no tracked response for id unknown'
                ),
              }),
            ])
          }),
          Effect.scoped,

          provideNoopBareSender
        )
      )
      expect(onResult).not.toHaveBeenCalled()
    })

    it('calls onResult with the RemoteResponse + a Right of parsed resources on a match', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      const body = JSON.stringify({ name: 'Carol', age: 40 })
      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandler(handler.ResponseData(responseData('r1', body)))
      runHandler(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/99')
      expect(response.text()).toBe(body)
      expectRightToEqual(result, [{ name: 'Carol', age: 40 }])
    })

    it('removes the response after finishing so a second ResponseFinished is a no-op', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(handler.ResponseData(responseData('r1', '{}')))
      runHandler(handler.ResponseFinished(responseFinished('r1')))
      // Second finish: tracked entry is gone → log + no-op.
      expect(() => runHandler(handler.ResponseFinished(responseFinished('r1')))).not.toThrow()
      // Only the first finish should have produced an onResult call.
      expect(onResult).toHaveBeenCalledOnce()
    })

    it('routes to the first entity whose isFoundAt matches when multiple match', () => {
      const OverlappingEntity: EntityDefinition.EntityDefinition<SimpleResources> =
        EntityDefinition.make({
          name: 'OverlappingEntity',
          isFoundAt: (url) => /\/people\//.test(url),
          parse: () => Effect.succeed([]),
        })

      const onResult = vi.fn()
      const handler = Effect.runSync(
        CollectorBridgeMessageHandler.make<SimpleResources>({
          scrapingPlan: ScrapingPlan.make<SimpleResources>({
            name: 'OverlappingPlan',
            entityDefinitions: [OverlappingEntity, SimpleEntity],
            firstPage: { _tag: 'Uri', uri: 'https://example.com/' },
            linkSequence: [],
            stepDelay: Duration.seconds(5),
          }),
          sendMessage: noopSendMessage,
          onResult,
        })
      )

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(handler.ResponseData(responseData('r1', '{}')))
      runHandler(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      // Overlapping wins because it's first in `entityDefinitions`; its parse
      // returns an empty resource list regardless of body.
      expectRightToEqual(onResult.mock.calls[0][0].result, [])
    })

    it('handles multiple concurrent tracked responses independently', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      runHandler(
        handler.ResponseData(responseData('r1', JSON.stringify({ name: 'Alice', age: 30 })))
      )
      runHandler(handler.ResponseData(responseData('r2', JSON.stringify({ name: 'Bob', age: 25 }))))

      runHandler(handler.ResponseFinished(responseFinished('r2')))
      runHandler(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledTimes(2)
      expectRightToEqual(onResult.mock.calls[0][0].result, [{ name: 'Bob', age: 25 }])
      expectRightToEqual(onResult.mock.calls[1][0].result, [{ name: 'Alice', age: 30 }])
    })
  })

  describe('Cancelled', () => {
    it('emits onResult Left(SnifferCancelled) and drops the entry for a tracked response', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(handler.Cancelled(cancelled('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/1')
      expectLeftToEqual(result, expect.objectContaining({ _tag: 'SnifferCancelled', id: 'r1' }))
      expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r1')
    })

    it('emits a WARN log and no-ops for an unsolicited Cancelled (id not tracked)', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      await Effect.runPromise(
        handler.Cancelled(cancelled('unknown')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.Cancelled: no tracked response for id unknown'
                ),
              }),
            ])
          }),
          Effect.scoped,

          provideNoopBareSender
        )
      )
      expect(onResult).not.toHaveBeenCalled()
    })
  })

  describe('clear', () => {
    it('drops every in-flight tracked response without emitting onResult', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandler(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      expect(MutableHashMap.size(handler.inProgressResponses)).toBe(2)

      Effect.runSync(handler.clear())

      expect(MutableHashMap.size(handler.inProgressResponses)).toBe(0)
      expect(onResult).not.toHaveBeenCalled()
    })
  })

  describe('RequestError', () => {
    it('calls onResult with a Left(UnknownException) carrying the error message', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandler(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandler(
        handler.RequestError(
          requestError({
            id: 'r1',
            url: 'https://example.com/people/99',
            message: 'network down',
          })
        )
      )

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/99')
      // `UnknownException` stores the original payload on `.cause` (and a
      // mirroring `.error`); `.message` is the generic "An unknown error
      // occurred" string. Assert on `cause` so the test pins the actual
      // RequestError → UnknownException wiring.
      expectLeftToEqual(
        result,
        expect.objectContaining({
          _tag: 'UnknownException',
          cause: 'network down',
        })
      )
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      await Effect.runPromise(
        handler
          .RequestError(
            requestError({ id: 'unknown', url: 'https://example.com', message: 'oops' })
          )
          .pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toEqual([
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining(
                    'CollectorBridgeMessageHandler.RequestError: no tracked response for id unknown'
                  ),
                }),
              ])
            }),
            Effect.scoped,

            provideNoopBareSender
          )
      )
      expect(onResult).not.toHaveBeenCalled()
    })
  })

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
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
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
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
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
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
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
            Effect.scoped,

            provideNoopBareSender
          )

          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          // Still only the one SniffingComplete from earlier.
          expect(sendMessage).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
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
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
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
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
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
        }).pipe(Effect.provide(TestContext.TestContext), provideNoopBareSender)
      ))
  })
})
