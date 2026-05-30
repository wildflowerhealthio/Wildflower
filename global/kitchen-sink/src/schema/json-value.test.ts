import { Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { numRunsFor } from '../test/num-runs-for.ts'
import { utilityExpectations } from '../test/utility-expectations.ts'
import { JsonValue } from './json-value.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

const containsNegativeZero = (v: unknown): boolean => {
  if (typeof v === 'number') return Object.is(v, -0)
  if (Array.isArray(v)) return v.some(containsNegativeZero)
  if (v !== null && typeof v === 'object') {
    return Object.values(v).some(containsNegativeZero)
  }
  return false
}

describe('JsonValue', () => {
  describe('accepts JSON-safe values', () => {
    it.each([
      { name: 'string', value: 'hello' },
      { name: 'finite number', value: 42 },
      { name: 'zero', value: 0 },
      { name: 'negative', value: -1.5 },
      { name: 'true', value: true },
      { name: 'false', value: false },
      { name: 'null', value: null },
      { name: 'empty object', value: {} },
      { name: 'empty array', value: [] },
      { name: 'nested object', value: { a: { b: { c: 1 } } } },
      { name: 'mixed array', value: [1, 'two', null, { three: true }] },
    ])('decodes $name', ({ value }) => {
      expectRightToEqual(Schema.decodeUnknownEither(JsonValue)(value), value)
    })
  })

  describe('rejects non-JSON-safe values', () => {
    it.each([
      { name: 'undefined', value: undefined },
      { name: 'Infinity', value: Number.POSITIVE_INFINITY },
      { name: '-Infinity', value: Number.NEGATIVE_INFINITY },
      { name: 'NaN', value: Number.NaN },
      { name: 'function', value: (): null => null },
      { name: 'symbol', value: Symbol('s') },
      { name: 'bigint', value: BigInt(1) },
      { name: 'object with undefined field', value: { a: undefined } },
      { name: 'object with Infinity field', value: { a: Number.POSITIVE_INFINITY } },
    ])('rejects $name', ({ value }) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(JsonValue)(value),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    })
  })

  it('round-trips through JSON.stringify / JSON.parse for any JsonValue', () => {
    // `JSON.stringify` collapses `-0` to `"0"`, so a sample containing
    // `-0` would re-decode to `0` and the structural equality below
    // would fail. Filter those out — the schema itself still accepts
    // `-0`; the round-trip property just doesn't hold for it.
    fc.assert(
      fc.property(
        fc.jsonValue().filter((v) => !containsNegativeZero(v)),
        (value) => {
          // Anything fast-check's `jsonValue` generates is by definition
          // JSON-safe; the schema should accept all of it and the
          // serialized form should re-decode to the same value.
          const decoded = Schema.decodeUnknownSync(JsonValue)(value)
          const roundTripped = Schema.decodeUnknownSync(JsonValue)(
            JSON.parse(JSON.stringify(decoded))
          )
          expect(roundTripped).toEqual(decoded)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
