// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment lint fires on idiomatic `mock.calls[0]` access here

import type { CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Duration, Effect, MutableHashMap } from 'effect'
import { LoggingLayerTest, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { EntityDefinition, ScrapingPlan } from 'collector-fundamentals/model'
import { AnotherEntity, SimpleEntity } from 'collector-fundamentals/test-helpers'
import {
  cancelled,
  drainResults,
  makeSimpleHandler,
  noopSendMessage,
  requestError,
  responseData,
  responseFinished,
  responseStart,
  runHandlerPromise,
  runHandlerSync,
  type SimpleHandlerArgs,
  type SimpleResources,
} from './collector-bridge-message-handler.test-helpers.ts'
import * as CollectorBridgeMessageHandler from './collector-bridge-message-handler.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

// The lifecycle's completion coupling (`markSniffingComplete` / `abandonAllRequestSniffing` ending the
// `results` mailbox) now lives on the `RunLifecycleState`; see `run-lifecycle-state.test.ts`.

describe('CollectorBridgeMessageHandler.make: sniffer response tracker', () => {
  describe('ResponseStart', () => {
    it('begins tracking when the URL matches some entity', () => {
      const sendMessage = vi.fn(noopSendMessage)
      const handler = makeSimpleHandler({ sendMessage })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/42' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).toContain('r1')
    })

    it('cancels via sendMessage when no entity matches', () => {
      const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
      const handler = makeSimpleHandler({ sendMessage })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/unknown' }))
      )

      expect(sendMessage).toHaveBeenCalledOnce()
      expect(sendMessage.mock.calls[0][0]).toEqual({
        _tag: 'CancelSnifferRequest',
        id: 'r2',
      } satisfies typeof CancelSnifferRequestMessage.Type)
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).not.toContain('r2')
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
            stepSequence: [],
            stepDelay: Duration.seconds(5),
          }),
          sendMessage,
        })
      )

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/items/abc' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).toContain('r1')
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).toContain('r2')
    })
  })

  describe('ResponseData', () => {
    it('appends a base64-decoded chunk to a tracked response', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{"name":"Bob"')))
      runHandlerSync(handler.ResponseData(responseData('r1', ',"age":25}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      expectRightToEqual(results[0], [{ name: 'Bob', age: 25 }])
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
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
          Effect.scoped
        )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })

    it('offers a Left(UnknownException) and drops the entry when base64 decode fails on a tracked response', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseData({ _tag: 'ResponseData', id: 'r1', data: '!!! not base64 !!!' })
      )
      // The tracked entry is removed so a subsequent ResponseFinished
      // becomes a no-op rather than a duplicate result event.
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).not.toContain('r1')
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      expectLeftToEqual(
        results[0],
        expect.objectContaining({
          url: 'https://example.com/people/1',
          error: expect.objectContaining({ _tag: 'UnknownException' }),
        })
      )
    })
  })

  describe('ResponseFinished', () => {
    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
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
          Effect.scoped
        )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })

    it('offers a Right of parsed resources on a match', () => {
      const handler = makeSimpleHandler()

      const body = JSON.stringify({ name: 'Carol', age: 40 })
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', body)))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      // The parsed resources reflect the appended body chunks; the response
      // URL is asserted on the failure paths (which keep it on the `Left`).
      expectRightToEqual(results[0], [{ name: 'Carol', age: 40 }])
    })

    it('removes the response after finishing so a second ResponseFinished is a no-op', async () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))
      // Second finish: tracked entry is gone → log + no-op.
      await runHandlerPromise(
        handler.ResponseFinished(responseFinished('r1')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.ResponseFinished: no tracked response for id r1'
                ),
              }),
            ])
          }),
          Effect.scoped
        )
      )
      // Only the first finish should have produced a result event.
      expect(drainResults(handler)).toHaveLength(1)
    })

    it('routes to the first entity whose isFoundAt matches when multiple match', () => {
      const OverlappingEntity: EntityDefinition.EntityDefinition<SimpleResources> =
        EntityDefinition.make({
          name: 'OverlappingEntity',
          isFoundAt: (url) => /\/people\//.test(url),
          parse: () => Effect.succeed([]),
        })

      const handler = Effect.runSync(
        CollectorBridgeMessageHandler.make<SimpleResources>({
          scrapingPlan: ScrapingPlan.make<SimpleResources>({
            name: 'OverlappingPlan',
            entityDefinitions: [OverlappingEntity, SimpleEntity],
            firstPage: { _tag: 'Uri', uri: 'https://example.com/' },
            stepSequence: [],
            stepDelay: Duration.seconds(5),
          }),
          sendMessage: noopSendMessage,
        })
      )

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      // Overlapping wins because it's first in `entityDefinitions`; its parse
      // returns an empty resource list regardless of body.
      expectRightToEqual(results[0], [])
    })

    it('handles multiple concurrent tracked responses independently', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      runHandlerSync(
        handler.ResponseData(responseData('r1', JSON.stringify({ name: 'Alice', age: 30 })))
      )
      runHandlerSync(
        handler.ResponseData(responseData('r2', JSON.stringify({ name: 'Bob', age: 25 })))
      )

      runHandlerSync(handler.ResponseFinished(responseFinished('r2')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      // Result events arrive in finish order: r2 first, then r1.
      const results = drainResults(handler)
      expect(results).toHaveLength(2)
      expectRightToEqual(results[0], [{ name: 'Bob', age: 25 }])
      expectRightToEqual(results[1], [{ name: 'Alice', age: 30 }])
    })
  })

  describe('Cancelled', () => {
    it('offers a Left(SnifferCancelled) and drops the entry for a tracked response', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.Cancelled(cancelled('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      expectLeftToEqual(
        results[0],
        expect.objectContaining({
          url: 'https://example.com/people/1',
          error: expect.objectContaining({ _tag: 'SnifferCancelled', id: 'r1' }),
        })
      )
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).not.toContain('r1')
    })

    it('emits a WARN log and no-ops for an unsolicited Cancelled (id not tracked)', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
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
          Effect.scoped
        )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })
  })

  describe('RequestError', () => {
    it('offers a Left(UnknownException) carrying the error message', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandlerSync(
        handler.RequestError(
          requestError({
            id: 'r1',
            url: 'https://example.com/people/99',
            message: 'network down',
          })
        )
      )

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      // `UnknownException` stores the original payload on `.cause` (and a
      // mirroring `.error`); `.message` is the generic "An unknown error
      // occurred" string. Assert on `cause` so the test pins the actual
      // RequestError → UnknownException wiring, plus the folded-in `url`.
      expectLeftToEqual(
        results[0],
        expect.objectContaining({
          url: 'https://example.com/people/99',
          error: expect.objectContaining({
            _tag: 'UnknownException',
            cause: 'network down',
          }),
        })
      )
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
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
            Effect.scoped
          )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })
  })

  describe('cancelAllRequestSniffing', () => {
    it('drops every incomplete sniffed request without publishing a result', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      expect(MutableHashMap.size(handler.incompleteSniffedRequests)).toBe(2)

      runHandlerSync(handler.cancelAllRequestSniffing(noopSendMessage))

      expect(MutableHashMap.size(handler.incompleteSniffedRequests)).toBe(0)
      expect(drainResults(handler)).toHaveLength(0)
    })
  })
})
