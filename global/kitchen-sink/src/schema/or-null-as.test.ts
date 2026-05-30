import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { numRunsFor } from '../test/num-runs-for.ts'
import { OrNullAsOptional } from './or-null-as-optional.ts'
import { OrNullAsUndefined } from './or-null-as-undefined.ts'

describe('OrNullAsUndefined', () => {
  const schema = OrNullAsUndefined(Schema.NumberFromString)

  describe('types', () => {
    it('exposes A | null on the type side', () => {
      expectTypeOf<typeof schema.Type>().toEqualTypeOf<number | null>()
    })

    it('exposes I | undefined on the encoded side', () => {
      expectTypeOf<typeof schema.Encoded>().toEqualTypeOf<string | undefined>()
    })

    it('has no required context', () => {
      expectTypeOf<typeof schema.Context>().toEqualTypeOf<never>()
    })
  })

  describe('decode', () => {
    it('decodes a present encoded value through the inner schema', () => {
      const result = Schema.decodeUnknownSync(schema)('42')
      expect(result).toBe(42)
    })

    it('decodes undefined to null', () => {
      const result = Schema.decodeUnknownSync(schema)(undefined)
      expect(result).toBeNull()
    })

    it('throws on input the inner schema cannot decode', () => {
      expect(() => Schema.decodeUnknownSync(schema)('not-a-number')).toThrow()
    })
  })

  describe('encode', () => {
    it('encodes a value through the inner schema', () => {
      const result = Schema.encodeSync(schema)(42)
      expect(result).toBe('42')
    })

    it('encodes null to undefined', () => {
      const result = Schema.encodeSync(schema)(null)
      expect(result).toBeUndefined()
    })
  })

  describe('round trip', () => {
    const innerArb = Arbitrary.make(Schema.NumberFromString)
    const typeArb = fc.oneof(
      fc.constant(null),
      innerArb.filter((n) => !Object.is(n, -0.0))
    )

    it('round trips type values: type -> encoded -> type', () => {
      fc.assert(
        fc.property(typeArb, (value) => {
          const encoded = Schema.encodeSync(schema)(value)
          const reDecoded = Schema.decodeUnknownSync(schema)(encoded)
          expect(reDecoded).toEqual(value)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    it('round trips encoded values: encoded -> type -> encoded', () => {
      const encodedArb = typeArb.map((value) => Schema.encodeSync(schema)(value))
      fc.assert(
        fc.property(encodedArb, (encoded) => {
          const decoded = Schema.decodeUnknownSync(schema)(encoded)
          const reEncoded = Schema.encodeSync(schema)(decoded)
          expect(reEncoded).toEqual(encoded)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})

describe('OrNullAsOptional', () => {
  const struct = Schema.Struct({ value: OrNullAsOptional(Schema.NumberFromString) })

  describe('types', () => {
    it('produces a struct with a non-optional A | null field', () => {
      expectTypeOf<typeof struct.Type>().toEqualTypeOf<{ readonly value: number | null }>()
    })

    it('produces a struct whose encoded form has an optional I | undefined field', () => {
      expectTypeOf<typeof struct.Encoded>().toEqualTypeOf<{
        readonly value?: string | undefined
      }>()
    })
  })

  describe('decode', () => {
    it('decodes a present value through the inner schema', () => {
      const result = Schema.decodeUnknownSync(struct)({ value: '42' })
      expect(result).toEqual({ value: 42 })
    })

    it('decodes a missing key to null via the default', () => {
      const result = Schema.decodeUnknownSync(struct)({})
      expect(result).toEqual({ value: null })
    })

    it('decodes an explicit undefined to null', () => {
      const result = Schema.decodeUnknownSync(struct)({ value: undefined })
      expect(result).toEqual({ value: null })
    })

    it('throws on input the inner schema cannot decode', () => {
      expect(() => Schema.decodeUnknownSync(struct)({ value: 'not-a-number' })).toThrow()
    })
  })

  describe('encode', () => {
    it('encodes a value through the inner schema', () => {
      const result = Schema.encodeSync(struct)({ value: 42 })
      expect(result).toEqual({ value: '42' })
    })

    it('encodes null such that the field decodes back to null', () => {
      const result = Schema.encodeSync(struct)({ value: null })
      expect(result.value).toBeUndefined()
      expect(Schema.decodeUnknownSync(struct)(result)).toEqual({ value: null })
    })
  })

  describe('round trip', () => {
    const innerArb = Arbitrary.make(Schema.NumberFromString)
    const typeArb = fc.record({
      value: fc.oneof(
        fc.constant(null),
        innerArb.filter((n) => !Object.is(n, -0.0))
      ),
    })

    it('round trips type values: type -> encoded -> type', () => {
      fc.assert(
        fc.property(typeArb, (value) => {
          const encoded = Schema.encodeSync(struct)(value)
          const reDecoded = Schema.decodeUnknownSync(struct)(encoded)
          expect(reDecoded).toEqual(value)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    it('round trips encoded values: encoded -> type -> encoded', () => {
      const encodedArb = typeArb.map((value) => Schema.encodeSync(struct)(value))
      fc.assert(
        fc.property(encodedArb, (encoded) => {
          const decoded = Schema.decodeUnknownSync(struct)(encoded)
          const reEncoded = Schema.encodeSync(struct)(decoded)
          expect(reEncoded).toEqual(encoded)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
