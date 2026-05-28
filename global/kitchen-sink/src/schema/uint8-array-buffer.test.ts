import { Arbitrary, Either, Encoding, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { numRunsFor } from '../test/num-runs-for.ts'
import { Base64FromUint8ArrayBuffer, Uint8ArrayBufferFromSelf } from './uint8-array-buffer.ts'

describe('Uint8ArrayBufferFromSelf', () => {
  it('should decode a Uint8Array with an ArrayBuffer as its buffer', () => {
    const input = new Uint8Array([1, 2, 3])
    const result = Schema.decodeUnknownSync(Uint8ArrayBufferFromSelf)(input)
    expect(result).toBe(input)
  })

  it('should fail to decode a non-Uint8Array value', () => {
    expect(() => {
      Schema.decodeUnknownSync(Uint8ArrayBufferFromSelf)([1, 2, 3])
    }).toThrow()
  })

  it('should fail to decode a Uint8Array backed by a SharedArrayBuffer', () => {
    const shared = new SharedArrayBuffer(4)
    const input = new Uint8Array(shared)
    expect(() => {
      Schema.decodeUnknownSync(Uint8ArrayBufferFromSelf)(input)
    }).toThrow()
  })

  it('should have an arbitrary annotation that only produces ArrayBuffer-backed Uint8Arrays', () => {
    const arb = Arbitrary.make(Uint8ArrayBufferFromSelf)
    fc.assert(
      fc.property(arb, (value) => {
        expect(value).toBeInstanceOf(Uint8Array)
        expect(value.buffer).toBeInstanceOf(ArrayBuffer)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})

describe('Base64FromUint8ArrayBuffer', () => {
  it('should decode a Uint8Array into its base64 string representation', () => {
    const input = new Uint8Array([0, 1, 2])
    const result = Schema.decodeSync(Base64FromUint8ArrayBuffer)(input)
    expect(result).toBe('AAEC')
  })

  it('should encode a base64 string into a Uint8Array', () => {
    const result = Schema.encodeSync(Base64FromUint8ArrayBuffer)('AAEC')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(result)).toEqual([0, 1, 2])
  })

  it('should fail to encode an invalid base64 string', () => {
    const result = Schema.encodeEither(Base64FromUint8ArrayBuffer)('not*valid*base64')
    expect(Either.isLeft(result)).toBe(true)
  })

  it('should round trip: Uint8Array -> base64 -> Uint8Array', () => {
    const arb = Arbitrary.make(Uint8ArrayBufferFromSelf)
    fc.assert(
      fc.property(arb, (bytes) => {
        const encoded = Schema.decodeSync(Base64FromUint8ArrayBuffer)(bytes)
        const decoded = Schema.encodeSync(Base64FromUint8ArrayBuffer)(encoded)
        expect(Array.from(decoded)).toEqual(Array.from(bytes))
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  it('should round trip: base64 -> Uint8Array -> base64', () => {
    const base64Arb = fc.uint8Array().map((bytes) => Encoding.encodeBase64(bytes))
    fc.assert(
      fc.property(base64Arb, (base64) => {
        const bytes = Schema.encodeSync(Base64FromUint8ArrayBuffer)(base64)
        const reEncoded = Schema.decodeSync(Base64FromUint8ArrayBuffer)(bytes)
        expect(reEncoded).toBe(base64)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  it('should generate valid base64 strings via its arbitrary annotation', () => {
    const arb = Arbitrary.make(Base64FromUint8ArrayBuffer)
    fc.assert(
      fc.property(arb, (value) => {
        expect(typeof value).toBe('string')
        const result = Schema.encodeEither(Base64FromUint8ArrayBuffer)(value)
        expect(Either.isRight(result)).toBe(true)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})
