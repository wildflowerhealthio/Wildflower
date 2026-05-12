import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { RemoteResponse } from './response.ts'
import { SimpleEntity } from './test-helpers.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

const makeResponse = (body: string): RemoteResponse => {
  const r = new RemoteResponse('https://example.com/resource/id', 200, 'OK', {
    'content-type': 'text',
  })
  r.appendChunk(encoder.encode(body))
  return r
}

describe('Entity.make', () => {
  it('parses valid JSON into resources and links', () => {
    expectRightToEqual(
      SimpleEntity.parse(makeResponse(JSON.stringify({ name: 'Alice', age: 30 }))),
      {
        resources: [{ name: 'Alice', age: 30 }],
        links: [{ _tag: 'Open', href: '/people/Alice' }],
      }
    )
  })

  it('returns Left for malformed JSON', () => {
    expectLeftToEqual(
      SimpleEntity.parse(makeResponse('{ not valid json }')),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('returns Left when JSON does not match the schema', () => {
    expectLeftToEqual(
      SimpleEntity.parse(makeResponse(JSON.stringify({ name: 'Alice', age: 'not-a-number' }))),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('returns Left for JSON with missing required fields', () => {
    expectLeftToEqual(
      SimpleEntity.parse(makeResponse(JSON.stringify({ name: 'Alice' }))),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('never throws on arbitrary JSON strings', () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        const result = SimpleEntity.parse(makeResponse(json))
        expect(['Right', 'Left']).toContain(result._tag)
      })
    )
  })
})
