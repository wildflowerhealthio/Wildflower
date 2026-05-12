import { Either } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import * as EntityDefinition from './entity-definition.ts'
import * as Remote from './remote.ts'
import { AnotherEntity, SimpleEntity } from './test-helpers.ts'

const { expectRightToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

const baseStart = (overrides: {
  id: string
  url: string
}): Parameters<Remote.Remote['shouldKeepResponse']>[0] => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  ...overrides,
})

describe('Remote.make', () => {
  describe('shouldKeepResponse', () => {
    it('returns true when the URL matches some entity', () => {
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com/people' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult: () => undefined,
      })

      expect(
        remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/42' }))
      ).toBe(true)
      expect(
        remote.shouldKeepResponse(baseStart({ id: 'r2', url: 'https://example.com/unknown' }))
      ).toBe(false)
    })

    it('matches against any of the configured entities', () => {
      const remote = Remote.make<{ name: string; age: number } | { id: string }>({
        firstPage: { uri: 'https://example.com' },
        name: 'MultiRemote',
        entities: [SimpleEntity, AnotherEntity],
        onResult: () => undefined,
      })

      expect(
        remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      ).toBe(true)
      expect(
        remote.shouldKeepResponse(baseStart({ id: 'r2', url: 'https://example.com/items/abc' }))
      ).toBe(true)
    })
  })

  describe('handleResponseData', () => {
    it('appends a chunk to a tracked response', () => {
      const onResult = vi.fn<Remote.Config<{ name: string; age: number }>['onResult']>()
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com/people' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult,
      })

      remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      remote.handleResponseData({ id: 'r1', data: encoder.encode('{"name":"Bob"') })
      remote.handleResponseData({ id: 'r1', data: encoder.encode(',"age":25}') })
      remote.handleResponseFinished({ id: 'r1' })

      expect(onResult).toHaveBeenCalledOnce()
    })

    it('throws for an untracked response id', () => {
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult: () => undefined,
      })
      expect(() =>
        remote.handleResponseData({ id: 'unknown', data: encoder.encode('data') })
      ).toThrow('Received response data for response that is not being tracked')
    })
  })

  describe('handleResponseFinished', () => {
    it('throws for an untracked response id', () => {
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult: () => undefined,
      })
      expect(() => remote.handleResponseFinished({ id: 'unknown' })).toThrow(
        'getOrThrow called on a None'
      )
    })

    it('calls onResult with the RemoteResponse + a Right of parsed resources on a match', () => {
      const onResult = vi.fn<Remote.Config<{ name: string; age: number }>['onResult']>()
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com/people' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult,
      })

      const body = JSON.stringify({ name: 'Carol', age: 40 })
      remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      remote.handleResponseData({ id: 'r1', data: encoder.encode(body) })
      remote.handleResponseFinished({ id: 'r1' })

      expect(onResult).toHaveBeenCalledOnce()
      const [{ response, result }] = onResult.mock.calls[0]
      expect(response.url).toBe('https://example.com/people/99')
      expect(response.text()).toBe(body)
      expectRightToEqual(result, {
        resources: [{ name: 'Carol', age: 40 }],
        links: [{ _tag: 'Open', href: '/people/Carol' }],
      })
    })

    it('removes the response after finishing so it cannot be finished again', () => {
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com/people' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult: () => undefined,
      })

      remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      remote.handleResponseData({ id: 'r1', data: encoder.encode('{}') })
      remote.handleResponseFinished({ id: 'r1' })

      expect(() => remote.handleResponseFinished({ id: 'r1' })).toThrow(
        'getOrThrow called on a None'
      )
    })

    it('routes to the first entity whose isFoundAt matches when multiple match', () => {
      const OverlappingEntity: EntityDefinition.EntityDefinition<{ name: string; age: number }> =
        EntityDefinition.make({
          name: 'OverlappingEntity',
          isFoundAt: (url) => /\/people\//.test(url),
          parse: () => Either.right({ resources: [], links: [] }),
        })

      const onResult = vi.fn<Remote.Config<{ name: string; age: number }>['onResult']>()
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com' },
        name: 'OverlappingRemote',
        entities: [OverlappingEntity, SimpleEntity],
        onResult,
      })

      remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      remote.handleResponseData({ id: 'r1', data: encoder.encode('{}') })
      remote.handleResponseFinished({ id: 'r1' })

      expect(onResult).toHaveBeenCalledOnce()
      // Overlapping wins because it's first in `entities`; its parse returns
      // an empty resource list regardless of body.
      expectRightToEqual(onResult.mock.calls[0][0].result, { resources: [], links: [] })
    })

    it('handles multiple concurrent tracked responses independently', () => {
      const onResult = vi.fn<Remote.Config<{ name: string; age: number }>['onResult']>()
      const remote = Remote.make({
        firstPage: { uri: 'https://example.com/people' },
        name: 'TestRemote',
        entities: [SimpleEntity],
        onResult,
      })

      remote.shouldKeepResponse(baseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      remote.shouldKeepResponse(baseStart({ id: 'r2', url: 'https://example.com/people/2' }))

      remote.handleResponseData({
        id: 'r1',
        data: encoder.encode(JSON.stringify({ name: 'Alice', age: 30 })),
      })
      remote.handleResponseData({
        id: 'r2',
        data: encoder.encode(JSON.stringify({ name: 'Bob', age: 25 })),
      })

      remote.handleResponseFinished({ id: 'r2' })
      remote.handleResponseFinished({ id: 'r1' })

      expect(onResult).toHaveBeenCalledTimes(2)
      // r2 finished first
      expectRightToEqual(onResult.mock.calls[0][0].result, {
        resources: [{ name: 'Bob', age: 25 }],
        links: [{ _tag: 'Open', href: '/people/Bob' }],
      })
      // r1 finished second
      expectRightToEqual(onResult.mock.calls[1][0].result, {
        resources: [{ name: 'Alice', age: 30 }],
        links: [{ _tag: 'Open', href: '/people/Alice' }],
      })
    })
  })
})
