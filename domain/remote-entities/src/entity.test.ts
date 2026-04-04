import { Either } from 'effect'
import fc from 'fast-check'
import { describe, it, expect } from 'vite-plus/test'
import { SimpleEntity } from './test-helpers.ts'

const init = (body: string): { body: string; contentType: string; url: string } => ({
  body,
  contentType: 'text',
  url: 'https://example.com/resource/id',
})

describe('RemoteEntity', () => {
  it('should parse valid JSON into resources and links', () => {
    const body = JSON.stringify({ name: 'Alice', age: 30 })
    const result = new SimpleEntity(init(body)).parse()

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.resources).toEqual([{ name: 'Alice', age: 30 }])
      expect(result.right.links).toEqual([{ _tag: 'Open', href: '/people/Alice' }])
    }
  })

  it('should return Left for malformed JSON', () => {
    const result = new SimpleEntity(init('{ not valid json }')).parse()
    expect(Either.isLeft(result)).toBe(true)
  })

  it('should return Left when JSON does not match the schema', () => {
    const body = JSON.stringify({ name: 'Alice', age: 'not-a-number' })
    const result = new SimpleEntity(init(body)).parse()
    expect(Either.isLeft(result)).toBe(true)
  })

  it('should return Left for JSON with missing required fields', () => {
    const body = JSON.stringify({ name: 'Alice' })
    const result = new SimpleEntity(init(body)).parse()
    expect(Either.isLeft(result)).toBe(true)
  })

  it('should never throw on arbitrary JSON strings', () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        const result = new SimpleEntity(init(json)).parse()
        expect(Either.isRight(result) || Either.isLeft(result)).toBe(true)
      })
    )
  })
})
