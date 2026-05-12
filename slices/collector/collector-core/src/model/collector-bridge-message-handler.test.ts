// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment / unsafe-destructure lint fires on idiomatic `mock.calls[0]` access here

import type { CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Effect, Encoding, MutableHashMap } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { AnotherEntity, SimpleEntity } from '../test-helpers.ts'
import * as CollectorBridgeMessageHandler from './collector-bridge-message-handler.ts'
import * as EntityDefinition from './entity-definition.ts'
import * as Remote from './remote.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

type SimpleResources = { name: string; age: number }
type SimpleHandlerArgs = Parameters<typeof CollectorBridgeMessageHandler.make<SimpleResources>>[0]

const noopSendMessage: SimpleHandlerArgs['sendMessage'] = () => Effect.void

/**
 * Build a handler bound to a single-entity `Remote` (`SimpleEntity` only).
 * Most tests only care about one entity; the few that want overlapping or
 * multi-entity setups build the remote inline.
 */
const makeSimpleHandler = (
  overrides: Partial<SimpleHandlerArgs> = {}
): ReturnType<typeof CollectorBridgeMessageHandler.make<SimpleResources>> =>
  CollectorBridgeMessageHandler.make({
    remote: Remote.make<SimpleResources>({
      name: 'TestRemote',
      firstPage: { uri: 'https://example.com/people' },
      entityDefinitions: [SimpleEntity],
    }),
    sendMessage: noopSendMessage,
    onResult: () => undefined,
    ...overrides,
  })

type Handler = ReturnType<typeof CollectorBridgeMessageHandler.make<SimpleResources>>
type StartArg = Parameters<Handler['ResponseStart']>[0]
type DataArg = Parameters<Handler['ResponseData']>[0]
type FinishArg = Parameters<Handler['ResponseFinished']>[0]
type ErrorArg = Parameters<Handler['RequestError']>[0]

const responseStart = (overrides: { id: string; url: string }): StartArg => ({
  _tag: 'ResponseStart',
  status: 200,
  statusText: 'OK',
  headers: {},
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

describe('CollectorBridgeMessageHandler.make', () => {
  describe('ResponseStart', () => {
    it('begins tracking when the URL matches some entity', () => {
      const sendMessage = vi.fn(noopSendMessage)
      const handler = makeSimpleHandler({ sendMessage })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/42' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r1')
    })

    it('cancels via sendMessage when no entity matches', () => {
      const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
      const handler = makeSimpleHandler({ sendMessage })

      Effect.runSync(
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
      const handler = CollectorBridgeMessageHandler.make<MultiResources>({
        remote: Remote.make<MultiResources>({
          name: 'MultiRemote',
          firstPage: { uri: 'https://example.com' },
          // Each entity is `EntityDefinition<X>` with `X ⊂ MultiResources`; widen
          // the array to the union so the array literal typechecks.
          entityDefinitions: [
            SimpleEntity,
            AnotherEntity,
          ] as readonly EntityDefinition.EntityDefinition<MultiResources>[],
        }),
        sendMessage,
        onResult: () => undefined,
      })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(
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

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(handler.ResponseData(responseData('r1', '{"name":"Bob"')))
      Effect.runSync(handler.ResponseData(responseData('r1', ',"age":25}')))
      Effect.runSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      expectRightToEqual(onResult.mock.calls[0][0].result, {
        resources: [{ name: 'Bob', age: 25 }],
        links: [{ _tag: 'Open', href: '/people/Bob' }],
      })
    })

    it('logs and no-ops for an untracked response id (does not throw, does not call onResult)', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      expect(() =>
        Effect.runSync(handler.ResponseData(responseData('unknown', 'data')))
      ).not.toThrow()
      expect(onResult).not.toHaveBeenCalled()
    })

    it('emits onResult Left(UnknownException) and drops the entry when base64 decode fails on a tracked response', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(
        handler.ResponseData({ _tag: 'ResponseData', id: 'r1', data: '!!! not base64 !!!' })
      )

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/1')
      expectLeftToEqual(result, expect.objectContaining({ _tag: 'UnknownException' }))
      // The tracked entry is removed so a subsequent ResponseFinished
      // becomes a no-op rather than a duplicate onResult.
      expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r1')
      Effect.runSync(handler.ResponseFinished(responseFinished('r1')))
      expect(onResult).toHaveBeenCalledOnce()
    })
  })

  describe('ResponseFinished', () => {
    it('logs and no-ops for an untracked response id (does not throw, does not call onResult)', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      expect(() =>
        Effect.runSync(handler.ResponseFinished(responseFinished('unknown')))
      ).not.toThrow()
      expect(onResult).not.toHaveBeenCalled()
    })

    it('calls onResult with the RemoteResponse + a Right of parsed resources on a match', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      const body = JSON.stringify({ name: 'Carol', age: 40 })
      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      Effect.runSync(handler.ResponseData(responseData('r1', body)))
      Effect.runSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/99')
      expect(response.text()).toBe(body)
      expectRightToEqual(result, {
        resources: [{ name: 'Carol', age: 40 }],
        links: [{ _tag: 'Open', href: '/people/Carol' }],
      })
    })

    it('removes the response after finishing so a second ResponseFinished is a no-op', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(handler.ResponseData(responseData('r1', '{}')))
      Effect.runSync(handler.ResponseFinished(responseFinished('r1')))
      // Second finish: tracked entry is gone → log + no-op.
      expect(() => Effect.runSync(handler.ResponseFinished(responseFinished('r1')))).not.toThrow()
      // Only the first finish should have produced an onResult call.
      expect(onResult).toHaveBeenCalledOnce()
    })

    it('routes to the first entity whose isFoundAt matches when multiple match', () => {
      const OverlappingEntity: EntityDefinition.EntityDefinition<SimpleResources> =
        EntityDefinition.make({
          name: 'OverlappingEntity',
          isFoundAt: (url) => /\/people\//.test(url),
          parse: () => Effect.succeed({ resources: [], links: [] }),
        })

      const onResult = vi.fn()
      const handler = CollectorBridgeMessageHandler.make<SimpleResources>({
        remote: Remote.make<SimpleResources>({
          name: 'OverlappingRemote',
          firstPage: { uri: 'https://example.com' },
          entityDefinitions: [OverlappingEntity, SimpleEntity],
        }),
        sendMessage: noopSendMessage,
        onResult,
      })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(handler.ResponseData(responseData('r1', '{}')))
      Effect.runSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledOnce()
      // Overlapping wins because it's first in `entityDefinitions`; its parse
      // returns an empty resource list regardless of body.
      expectRightToEqual(onResult.mock.calls[0][0].result, { resources: [], links: [] })
    })

    it('handles multiple concurrent tracked responses independently', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      Effect.runSync(
        handler.ResponseData(responseData('r1', JSON.stringify({ name: 'Alice', age: 30 })))
      )
      Effect.runSync(
        handler.ResponseData(responseData('r2', JSON.stringify({ name: 'Bob', age: 25 })))
      )

      Effect.runSync(handler.ResponseFinished(responseFinished('r2')))
      Effect.runSync(handler.ResponseFinished(responseFinished('r1')))

      expect(onResult).toHaveBeenCalledTimes(2)
      expectRightToEqual(onResult.mock.calls[0][0].result, {
        resources: [{ name: 'Bob', age: 25 }],
        links: [{ _tag: 'Open', href: '/people/Bob' }],
      })
      expectRightToEqual(onResult.mock.calls[1][0].result, {
        resources: [{ name: 'Alice', age: 30 }],
        links: [{ _tag: 'Open', href: '/people/Alice' }],
      })
    })
  })

  describe('clear', () => {
    it('drops every in-flight tracked response without emitting onResult', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      expect(MutableHashMap.size(handler.inProgressResponses)).toBe(2)

      handler.clear()

      expect(MutableHashMap.size(handler.inProgressResponses)).toBe(0)
      expect(onResult).not.toHaveBeenCalled()
    })
  })

  describe('RequestError', () => {
    it('calls onResult with a Left(UnknownException) carrying the error message', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      Effect.runSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      Effect.runSync(
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

    it('logs and no-ops for an untracked response id (does not throw, does not call onResult)', () => {
      const onResult = vi.fn()
      const handler = makeSimpleHandler({ onResult })

      expect(() =>
        Effect.runSync(
          handler.RequestError(
            requestError({ id: 'unknown', url: 'https://example.com', message: 'oops' })
          )
        )
      ).not.toThrow()
      expect(onResult).not.toHaveBeenCalled()
    })
  })
})
