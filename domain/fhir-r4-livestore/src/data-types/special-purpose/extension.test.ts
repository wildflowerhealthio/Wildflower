import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { AllDatatypeNames } from '../datatype.ts'
import { Extension } from './extension.ts'

// Use decodeUnknown since we're constructing raw wire-format objects
const decode = Schema.decodeUnknownSync(Extension)

describe('Extension', () => {
  test('ResourceType static equals "Extension"', () => {
    expect(Extension.ResourceType).toBe('Extension')
  })

  test('property: minimal decode defaults resourceType and extension', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (url) => {
        const ext = decode({ url })
        expect(ext.resourceType).toBe('Extension')
        expect(ext.extension).toEqual([])
        expect(ext.url).toBe(url)
        expect(ext.value).toBeUndefined()
      })
    )
  })

  test('decodes with a string value variant', () => {
    const ext = decode({
      url: 'http://test',
      value: { _tag: 'string', string: 'hello' },
    })
    expect(ext.value?._tag).toBe('string')
    if (ext.value?._tag === 'string') {
      expect(ext.value.string).toBe('hello')
    }
  })

  test('decodes with a boolean value variant', () => {
    const ext = decode({
      url: 'http://test',
      value: { _tag: 'boolean', boolean: true },
    })
    expect(ext.value?._tag).toBe('boolean')
    if (ext.value?._tag === 'boolean') {
      expect(ext.value.boolean).toBe(true)
    }
  })

  test('decodes with value absent', () => {
    const ext = decode({ url: 'http://test' })
    expect(ext.value).toBeUndefined()
  })

  test('rejects unknown _tag in value', () => {
    expect(() =>
      decode({
        url: 'http://test',
        value: { _tag: 'notAType', notAType: 'x' },
      })
    ).toThrow()
  })

  test('property: value _tag is always a valid DatatypeName', () => {
    const allowedTags = new Set(AllDatatypeNames)
    const arb = Arbitrary.make(Extension)
    fc.assert(
      fc.property(arb, (ext) => {
        expect(ext).toBeInstanceOf(Extension)
        if (ext.value !== undefined) {
          expect(allowedTags.has(ext.value._tag)).toBe(true)
        }
      })
    )
  })

  test('self-recursive: decodes nested extensions preserving value', () => {
    const ext = decode({
      url: 'http://outer',
      extension: [
        {
          url: 'http://inner',
          value: { _tag: 'integer', integer: 42 },
        },
      ],
      value: { _tag: 'string', string: 'outer-value' },
    })
    expect(ext.extension).toHaveLength(1)
    expect(ext.extension[0].url).toBe('http://inner')
    expect(ext.extension[0].value?._tag).toBe('integer')
    if (ext.extension[0].value?._tag === 'integer') {
      expect(ext.extension[0].value.integer).toBe(42)
    }
  })

  test('round-trip encode/decode preserves value', () => {
    const encode = Schema.encodeSync(Extension)
    const input = decode({
      url: 'http://test',
      value: { _tag: 'dateTime', dateTime: '2024-01-01T00:00:00Z' },
    })
    const encoded = encode(input)
    const reDecoded = decode(encoded)
    expect(reDecoded.value?._tag).toBe('dateTime')
  })
})
