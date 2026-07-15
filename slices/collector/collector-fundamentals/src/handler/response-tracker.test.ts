// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment / unsafe-destructure lint fires on idiomatic `mock.calls[0]` access here

import type { CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Duration, Effect, MutableHashMap } from 'effect'
import { LoggingLayerTest, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { EntityDefinition, ScrapingPlan } from 'collector-fundamentals/model'
import { AnotherEntity, SimpleEntity } from 'collector-fundamentals/test-helpers'
import {
  cancelled,
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

describe('CollectorBridgeMessageHandler.make: response tracker', () => {
  describe('ResponseStart', () => {
    it('begins tracking when the URL matches some entity', () => {
      const sendMessage = vi.fn(noopSendMessage)
      const handler = makeSimpleHandler({ sendMessage })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/42' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r1')
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

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
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

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{"name":"Bob"')))
      runHandlerSync(handler.ResponseData(responseData('r1', ',"age":25}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      expectRightToEqual(onResult.mock.calls[0][0].result, [{ name: 'Bob', age: 25 }])
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

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
      expect(onResult).not.toHaveBeenCalled()
    })

    it('emits onResult Left(UnknownException) and drops the entry when base64 decode fails on a tracked response', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseData({ _tag: 'ResponseData', id: 'r1', data: '!!! not base64 !!!' })
      )

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/1')
      expectLeftToEqual(result, expect.objectContaining({ _tag: 'UnknownException' }))
      // The tracked entry is removed so a subsequent ResponseFinished
      // becomes a no-op rather than a duplicate onResult.
      expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r1')
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))
      expect(onResult).toHaveBeenCalledOnce()
    })
  })

  describe('ResponseFinished', () => {
    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

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
      expect(onResult).not.toHaveBeenCalled()
    })

    it('calls onResult with the RemoteResponse + a Right of parsed resources on a match', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      const body = JSON.stringify({ name: 'Carol', age: 40 })
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', body)))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/99')
      expect(response.text()).toBe(body)
      expectRightToEqual(result, [{ name: 'Carol', age: 40 }])
    })

    it('removes the response after finishing so a second ResponseFinished is a no-op', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

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

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      // Overlapping wins because it's first in `entityDefinitions`; its parse
      // returns an empty resource list regardless of body.
      expectRightToEqual(onResult.mock.calls[0][0].result, [])
    })

    it('handles multiple concurrent tracked responses independently', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

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

      expect(onResult).toHaveBeenCalledTimes(2)
      expectRightToEqual(onResult.mock.calls[0][0].result, [{ name: 'Bob', age: 25 }])
      expectRightToEqual(onResult.mock.calls[1][0].result, [{ name: 'Alice', age: 30 }])
    })
  })

  describe('Cancelled', () => {
    it('emits onResult Left(SnifferCancelled) and drops the entry for a tracked response', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.Cancelled(cancelled('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/1')
      expectLeftToEqual(result, expect.objectContaining({ _tag: 'SnifferCancelled', id: 'r1' }))
      expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r1')
    })

    it('emits a WARN log and no-ops for an unsolicited Cancelled (id not tracked)', async () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

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
      expect(onResult).not.toHaveBeenCalled()
    })
  })

  describe('RequestError', () => {
    it('calls onResult with a Left(UnknownException) carrying the error message', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

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
      expect(onResult).not.toHaveBeenCalled()
    })
  })

  describe('clear', () => {
    it('drops every in-flight tracked response without emitting onResult', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      expect(MutableHashMap.size(handler.inProgressResponses)).toBe(2)

      runHandlerSync(handler.clear())

      expect(MutableHashMap.size(handler.inProgressResponses)).toBe(0)
      expect(onResult).not.toHaveBeenCalled()
    })
  })
})
