import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Datatype, DatatypeChoice } from './datatype.ts'

// ---------------------------------------------------------------------------
// DatatypeChoice — tagged union factory
// ---------------------------------------------------------------------------

describe('DatatypeChoice', () => {
  const ValueChoice = DatatypeChoice(['string', 'boolean', 'integer'])
  const decode = Schema.decodeSync(ValueChoice)
  const decodeUnknown = Schema.decodeUnknownSync(ValueChoice)
  const encode = Schema.encodeSync(ValueChoice)

  describe('schema structure', () => {
    test('decodes a tagged string variant', () => {
      const result = decode({ _tag: 'string', string: 'hello' })
      expect(result).toEqual({ _tag: 'string', string: 'hello' })
    })

    test('decodes a tagged boolean variant', () => {
      const result = decode({ _tag: 'boolean', boolean: true })
      expect(result).toEqual({ _tag: 'boolean', boolean: true })
    })

    test('decodes a tagged integer variant', () => {
      const result = decode({ _tag: 'integer', integer: 42 })
      expect(result).toEqual({ _tag: 'integer', integer: 42 })
    })

    test('rejects unknown _tag', () => {
      expect(() => decodeUnknown({ Quantity: 1, _tag: 'Quantity' })).toThrow()
    })

    test('rejects missing _tag', () => {
      expect(() => decodeUnknown({ string: 'hello' })).toThrow()
    })
  })

  describe('round-trip encode/decode', () => {
    test('property: encode ∘ decode is identity', () => {
      const arb = Arbitrary.make(ValueChoice)
      fc.assert(
        fc.property(arb, (value) => {
          const encoded = encode(value)
          const decoded = decode(encoded)
          expect(decoded).toSchemaEqual(value)
        })
      )
    })
  })

  describe('arbitrary generation', () => {
    test('property: every generated value has exactly one _tag from the allowed set', () => {
      const allowedTags = new Set(['string', 'boolean', 'integer'])
      const arb = Arbitrary.make(ValueChoice)
      fc.assert(
        fc.property(arb, (value) => {
          expect(allowedTags.has(value._tag)).toBe(true)
          // Verify the variant carries its named field
          switch (value._tag) {
            case 'string': {
              expect(value.string).toBeDefined()
              break
            }
            case 'boolean': {
              expect(value.boolean).toBeDefined()
              break
            }
            case 'integer': {
              expect(value.integer).toBeDefined()
              break
            }
          }
        })
      )
    })
  })

  describe('type narrowing', () => {
    test('_tag narrows to specific variant', () => {
      const value = decode({ _tag: 'string', string: 'test' })
      if (value._tag === 'string') {
        // TypeScript narrows this — accessing .string is type-safe
        expect(value.string).toBe('test')
      }
    })
  })

  describe('as Schema.optional field', () => {
    const ResourceSchema = Schema.Struct({
      name: Schema.String,
      value: Schema.optional(ValueChoice),
    })
    const decodeResource = Schema.decodeSync(ResourceSchema)

    test('decodes with value present', () => {
      const result = decodeResource({
        name: 'test',
        value: { _tag: 'integer', integer: 99 },
      })
      expect(result.value).toEqual({ _tag: 'integer', integer: 99 })
    })

    test('decodes with value absent', () => {
      const result = decodeResource({ name: 'test' })
      expect(result.value).toBeUndefined()
    })

    test('property: arbitrary generates valid optional values', () => {
      const arb = Arbitrary.make(ResourceSchema)
      fc.assert(
        fc.property(arb, (resource) => {
          expect(resource.name).toBeTypeOf('string')
          if (resource.value !== undefined) {
            expect(resource.value._tag).toBeTypeOf('string')
          }
        })
      )
    })
  })
})

// ---------------------------------------------------------------------------
// DatatypeChoice with overrideFields
// ---------------------------------------------------------------------------

describe('DatatypeChoice with overrideFields', () => {
  const CustomStringSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10))
  const CustomStringDatatype = Datatype('string', CustomStringSchema)

  const ChoiceWithOverride = DatatypeChoice(['string', 'boolean'], [CustomStringDatatype])
  const decode = Schema.decodeSync(ChoiceWithOverride)

  test('override schema is used for the specified type', () => {
    // Valid: string within 1-10 chars
    expect(() => decode({ _tag: 'string', string: 'hello' })).not.toThrow()
    // Invalid: empty string violates minLength(1)
    expect(() => decode({ _tag: 'string', string: '' })).toThrow()
    // Invalid: too long
    expect(() => decode({ _tag: 'string', string: 'this is way too long' })).toThrow()
  })

  test('non-overridden type uses default schema', () => {
    expect(() => decode({ _tag: 'boolean', boolean: true })).not.toThrow()
  })

  test('property: arbitrary respects override constraints', () => {
    const arb = Arbitrary.make(ChoiceWithOverride)
    fc.assert(
      fc.property(arb, (value) => {
        if (value._tag === 'string') {
          expect(value.string.length).toBeGreaterThanOrEqual(1)
          expect(value.string.length).toBeLessThanOrEqual(10)
        }
      })
    )
  })
})

// ---------------------------------------------------------------------------
// DatatypeChoice.cases
// ---------------------------------------------------------------------------

describe('DatatypeChoice.cases', () => {
  const ValueChoice = DatatypeChoice(['string', 'boolean', 'integer'])
  const decode = Schema.decodeSync(ValueChoice)

  test('active tag key holds the inner value', () => {
    const v = decode({ _tag: 'string', string: 'hello' })
    const c = DatatypeChoice.cases(v)
    expect(c.string).toBe('hello')
  })

  test('inactive tag keys are undefined', () => {
    const v = decode({ _tag: 'string', string: 'hello' })
    const c = DatatypeChoice.cases(v)
    expect(c.boolean).toBeUndefined()
    expect(c.integer).toBeUndefined()
  })

  test('works with boolean variant', () => {
    const v = decode({ _tag: 'boolean', boolean: true })
    const c = DatatypeChoice.cases(v)
    expect(c.boolean).toBe(true)
    expect(c.string).toBeUndefined()
  })

  test('undefined input returns all-undefined cases', () => {
    const c = DatatypeChoice.cases(undefined as typeof ValueChoice.Type | undefined)
    expect(c.string).toBeUndefined()
    expect(c.boolean).toBeUndefined()
    expect(c.integer).toBeUndefined()
  })

  test('property: exactly one key is defined', () => {
    const arb = Arbitrary.make(ValueChoice)
    fc.assert(
      fc.property(arb, (value) => {
        const c = DatatypeChoice.cases(value)
        const definedKeys = (['string', 'boolean', 'integer'] as const).filter(
          (k) => c[k] !== undefined
        )
        expect(definedKeys).toHaveLength(1)
        expect(definedKeys[0]).toBe(value._tag)
      })
    )
  })
})

// ---------------------------------------------------------------------------
// DatatypeChoice.match
// ---------------------------------------------------------------------------

describe('DatatypeChoice.match', () => {
  const ValueChoice = DatatypeChoice(['string', 'boolean', 'integer'])
  const decode = Schema.decodeSync(ValueChoice)

  describe('exhaustive (no default)', () => {
    const format = (v: typeof ValueChoice.Type): string =>
      DatatypeChoice.match(v, {
        boolean: (b) => `bool:${b}`,
        integer: (n) => `int:${n}`,
        string: (s) => `str:${s}`,
      })

    test('matches string variant', () => {
      expect(format(decode({ _tag: 'string', string: 'hi' }))).toBe('str:hi')
    })

    test('matches boolean variant', () => {
      expect(format(decode({ _tag: 'boolean', boolean: false }))).toBe('bool:false')
    })

    test('matches integer variant', () => {
      expect(format(decode({ _tag: 'integer', integer: 42 }))).toBe('int:42')
    })

    test('property: every generated value matches exactly one handler', () => {
      const arb = Arbitrary.make(ValueChoice)
      fc.assert(
        fc.property(arb, (value) => {
          const result = format(value)
          expect(result).toBeTypeOf('string')
          expect(result.length).toBeGreaterThan(0)
        })
      )
    })
  })

  describe('partial with default', () => {
    test('matched tag uses its handler', () => {
      const v = decode({ _tag: 'string', string: 'hi' })
      const result = DatatypeChoice.match(v, { string: (s) => s.toUpperCase() }, () => 'default')
      expect(result).toBe('HI')
    })

    test('unmatched tag uses default', () => {
      const v = decode({ _tag: 'integer', integer: 99 })
      const result = DatatypeChoice.match(v, { string: (s) => s.toUpperCase() }, () => 'default')
      expect(result).toBe('default')
    })

    test('default receives the full variant', () => {
      const v = decode({ _tag: 'boolean', boolean: true })
      const result = DatatypeChoice.match(
        v,
        { string: (s) => s },
        (unmatched): string => unmatched._tag
      )
      expect(result).toBe('boolean')
    })
  })

  test('throws when no handler and no default', () => {
    // Simulate a tag not covered at runtime (e.g. data from a newer server)
    const fabricated = {
      _tag: 'decimal',
      decimal: 1.5,
    } as unknown as typeof ValueChoice.Type
    expect(() =>
      DatatypeChoice.match(fabricated, {
        boolean: (b) => `${b}`,
        integer: (n) => `${n}`,
        string: String,
      })
    ).toThrow('no handler for tag "decimal"')
  })
})
