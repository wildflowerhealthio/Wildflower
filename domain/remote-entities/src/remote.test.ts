import { Either } from 'effect'
import type { ParseError } from 'effect/ParseResult'
import { describe, it, expect, vi } from 'vite-plus/test'
import { RemoteEntity, type RemoteEntityConstructor } from './entity.ts'
import type * as Link from './link.ts'
import { Remote } from './remote.ts'
import type { Any } from './source.ts'
import { SimpleEntity, AnotherEntity } from './test-helpers.ts'

/** Concrete subclass so we can instantiate Remote in tests */
class TestRemote extends Remote<{ name: string; age: number }> {
  public get firstPage(): Any {
    return { uri: 'https://example.com/people' }
  }
  public name: string = 'TestRemote'
  protected remoteEntityConstructors: readonly RemoteEntityConstructor<{
    name: string
    age: number
  }>[] = [SimpleEntity]
}
const encoder = new TextEncoder()

describe('Remote', () => {
  describe('shouldKeepResponse()', () => {
    it('should return true when URL matches a constructor', () => {
      const remote = new TestRemote(() => {})
      const result = remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/42',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      expect(result).toBe(true)
    })

    it('should return false when URL does not match any constructor', () => {
      const remote = new TestRemote(() => {})
      const result = remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/unknown/path',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      expect(result).toBe(false)
    })

    it('should match against multiple constructors', () => {
      class MultiRemote extends Remote<{ name: string; age: number } | { id: string }> {
        public readonly firstPage: Any = { uri: 'https://example.com' }
        public readonly name = 'MultiRemote'
        protected readonly remoteEntityConstructors = [SimpleEntity, AnotherEntity]
      }

      const remote = new MultiRemote(() => {})

      expect(
        remote.shouldKeepResponse({
          id: 'r1',
          url: 'https://example.com/people/1',
          status: 200,
          statusText: 'OK',
          headers: {},
        })
      ).toBe(true)

      expect(
        remote.shouldKeepResponse({
          id: 'r2',
          url: 'https://example.com/items/abc',
          status: 200,
          statusText: 'OK',
          headers: {},
        })
      ).toBe(true)
    })
  })

  describe('handleResponseData()', () => {
    it('should append data to a tracked response', () => {
      const handleEntityReceived = vi.fn<ConstructorParameters<typeof TestRemote>[0]>()
      const remote = new TestRemote(handleEntityReceived)

      remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/1',
        status: 200,
        statusText: 'OK',
        headers: {},
      })

      // Should not throw
      remote.handleResponseData({ id: 'r1', data: encoder.encode('{"name":"Bob"') })
      remote.handleResponseData({ id: 'r1', data: encoder.encode(',"age":25}') })

      remote.handleResponseFinished({ id: 'r1' })

      expect(handleEntityReceived).toHaveBeenCalledOnce()
    })

    it('should throw for an untracked response ID', () => {
      const remote = new TestRemote(() => {})
      expect(() =>
        remote.handleResponseData({ id: 'unknown', data: encoder.encode('data') })
      ).toThrow('Received response data for response that is not being tracked')
    })
  })

  describe('handleResponseFinished()', () => {
    it('should throw for an untracked response ID', () => {
      const remote = new TestRemote(() => {})
      expect(() => remote.handleResponseFinished({ id: 'unknown' })).toThrow(
        'getOrThrow called on a None'
      )
    })

    it('should call handleEntityReceived with the matching entity', () => {
      const handleEntityReceived = vi.fn<ConstructorParameters<typeof TestRemote>[0]>()
      const remote = new TestRemote(handleEntityReceived)
      const body = JSON.stringify({ name: 'Carol', age: 40 })

      remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/99',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      remote.handleResponseData({ id: 'r1', data: encoder.encode(body) })
      remote.handleResponseFinished({ id: 'r1' })

      expect(handleEntityReceived).toHaveBeenCalledOnce()
      const entity = handleEntityReceived.mock.calls[0][0]
      expect(entity).toBeInstanceOf(SimpleEntity)

      const parsed = entity.parse()
      expect(Either.isRight(parsed)).toBe(true)
      if (Either.isRight(parsed)) {
        expect(parsed.right.resources).toEqual([{ name: 'Carol', age: 40 }])
      }
    })

    it('should not call handleEntityReceived when no callback is provided', () => {
      const remote = new TestRemote(() => {})
      const body = JSON.stringify({ name: 'Dave', age: 50 })

      remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/1',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      remote.handleResponseData({ id: 'r1', data: encoder.encode(body) })

      // Should not throw even without a callback
      expect(() => remote.handleResponseFinished({ id: 'r1' })).not.toThrow()
    })

    it('should remove the response after finishing so it cannot be finished again', () => {
      const remote = new TestRemote(() => {})

      remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/1',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      remote.handleResponseData({ id: 'r1', data: encoder.encode('{}') })
      remote.handleResponseFinished({ id: 'r1' })

      expect(() => remote.handleResponseFinished({ id: 'r1' })).toThrow(
        'getOrThrow called on a None'
      )
    })

    it('should match the first matching constructor when multiple match', () => {
      // Both constructors match URLs containing /people/
      class OverlappingEntity extends RemoteEntity<{ name: string; age: number }> {
        public static readonly name = 'OverlappingEntity'
        public static isFoundAt(url: string): boolean {
          return /\/people\//.test(url)
        }
        parse(): Either.Either<
          { resources: readonly { name: string; age: number }[]; links: readonly Link.Any[] },
          ParseError
        > {
          return Either.right({ resources: [], links: [] })
        }
      }

      class OverlappingRemote extends Remote<{ name: string; age: number }> {
        public readonly firstPage: Any = { uri: 'https://example.com' }
        public readonly name = 'OverlappingRemote'
        protected readonly remoteEntityConstructors = [OverlappingEntity, SimpleEntity]
      }

      const handleEntityReceived = vi.fn()
      const remote = new OverlappingRemote(handleEntityReceived)

      remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/1',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      remote.handleResponseData({ id: 'r1', data: encoder.encode('{}') })
      remote.handleResponseFinished({ id: 'r1' })

      expect(handleEntityReceived).toHaveBeenCalledOnce()
      expect(handleEntityReceived.mock.calls[0][0]).toBeInstanceOf(OverlappingEntity)
    })

    it('should handle multiple concurrent tracked responses independently', () => {
      const handleEntityReceived = vi.fn<ConstructorParameters<typeof TestRemote>[0]>()
      const remote = new TestRemote(handleEntityReceived)

      remote.shouldKeepResponse({
        id: 'r1',
        url: 'https://example.com/people/1',
        status: 200,
        statusText: 'OK',
        headers: {},
      })
      remote.shouldKeepResponse({
        id: 'r2',
        url: 'https://example.com/people/2',
        status: 200,
        statusText: 'OK',
        headers: {},
      })

      const body1 = JSON.stringify({ name: 'Alice', age: 30 })
      const body2 = JSON.stringify({ name: 'Bob', age: 25 })

      // Interleave data for both responses
      remote.handleResponseData({ id: 'r1', data: encoder.encode(body1) })
      remote.handleResponseData({ id: 'r2', data: encoder.encode(body2) })

      remote.handleResponseFinished({ id: 'r2' })
      remote.handleResponseFinished({ id: 'r1' })

      expect(handleEntityReceived).toHaveBeenCalledTimes(2)

      // r2 finished first
      const firstEntity = handleEntityReceived.mock.calls[0][0]
      const firstParsed = firstEntity.parse()
      if (Either.isRight(firstParsed)) {
        expect(firstParsed.right.resources).toEqual([{ name: 'Bob', age: 25 }])
      }

      // r1 finished second
      const secondEntity = handleEntityReceived.mock.calls[1][0]
      const secondParsed = secondEntity.parse()
      if (Either.isRight(secondParsed)) {
        expect(secondParsed.right.resources).toEqual([{ name: 'Alice', age: 30 }])
      }
    })
  })
})
