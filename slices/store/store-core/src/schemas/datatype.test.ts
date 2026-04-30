import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as DatatypeChoice from './datatype-choice.ts'
import { Datatype } from './datatype.ts'

// ---------------------------------------------------------------------------
// DatatypeChoice — flat struct factory
// ---------------------------------------------------------------------------

describe('DatatypeChoice', () => {
  const valueChoice = DatatypeChoice.DatatypeChoice('value', ['string', 'boolean', 'integer'])

  const ValueChoice = Schema.Struct(valueChoice.fields)
  const decode = Schema.decodeSync(ValueChoice)
  const decodeUnknown = Schema.decodeUnknownSync(ValueChoice)
  const encode = Schema.encodeSync(ValueChoice)

  describe('schema structure', () => {
    test('decodes a valueString field', () => {
      const result = decode({ ...valueChoice.emptyEncoded, valueString: 'hello' })
      expect(result).toEqual({ valueString: 'hello', valueBoolean: null, valueInteger: null })
    })

    test('decodes a valueBoolean field', () => {
      const result = decode({ ...valueChoice.emptyEncoded, valueBoolean: true })
      expect(result).toEqual({ valueBoolean: true, valueInteger: null, valueString: null })
    })

    test('decodes a valueInteger field', () => {
      const result = decode({ ...valueChoice.emptyEncoded, valueInteger: 42 })
      expect(result).toEqual({ valueInteger: 42, valueBoolean: null, valueString: null })
    })

    test('accepts an empty object (all fields optional)', () => {
      const result = decode({ ...valueChoice.emptyEncoded })
      expect(result).toEqual({
        valueBoolean: null,
        valueInteger: null,
        valueString: null,
      })
    })

    test('accepts multiple fields simultaneously (no mutual exclusion)', () => {
      const result = decode({
        ...valueChoice.emptyEncoded,
        valueString: 'x',
        valueBoolean: false,
        valueInteger: 1,
      })
      expect(result).toEqual({ valueString: 'x', valueBoolean: false, valueInteger: 1 })
    })

    test('drops unknown prefixed fields (Schema.Struct default)', () => {
      const result = decodeUnknown({
        valueQuantity: 1,
        valueString: 'ok',
        valueBoolean: null,
        valueInteger: null,
      })
      expect(result).toEqual({ valueString: 'ok', valueBoolean: null, valueInteger: null })
    })
  })

  describe('round-trip encode/decode', () => {
    test('property: encode ∘ decode is identity', () => {
      const arb = Arbitrary.make(ValueChoice)
      fc.assert(
        fc.property(arb, (value) => {
          const encoded = encode(value)
          const decoded = decode(encoded)
          expect(decoded).toSchemaEqual(ValueChoice, value)
        })
      )
    })
  })

  describe('field naming', () => {
    test('capitalizes primitive names', () => {
      expect(Object.keys(ValueChoice.fields).toSorted()).toEqual(
        ['valueBoolean', 'valueInteger', 'valueString'].toSorted()
      )
    })

    test('preserves already-capitalized complex-type names', () => {
      const Choice = DatatypeChoice.DatatypeChoice('value', ['Quantity', 'Reference'])
      expect(Object.keys(Choice.fields).toSorted()).toEqual(
        ['valueQuantity', 'valueReference'].toSorted()
      )
    })

    test('applies arbitrary prefix', () => {
      const Effective = DatatypeChoice.DatatypeChoice('effective', ['dateTime', 'Period'])
      expect(Object.keys(Effective.fields).toSorted()).toEqual(
        ['effectiveDateTime', 'effectivePeriod'].toSorted()
      )
    })
  })

  describe('as a spread into a parent Schema.Struct', () => {
    const ResourceSchema = Schema.Struct({
      name: Schema.String,
      ...ValueChoice.fields,
    })
    const decodeResource = Schema.decodeSync(ResourceSchema)

    test('decodes with a choice field present', () => {
      const result = decodeResource({ name: 'test', ...valueChoice.emptyEncoded, valueInteger: 99 })
      expect(result.valueInteger).toBe(99)
      expect(result.valueString).toBeNull()
    })

    test('decodes with every choice field absent', () => {
      const result = decodeResource({ name: 'test', ...valueChoice.emptyEncoded })
      expect(result.valueString).toBeNull()
      expect(result.valueBoolean).toBeNull()
      expect(result.valueInteger).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// DatatypeChoice with overrideFields
// ---------------------------------------------------------------------------

describe('DatatypeChoice with overrideFields', () => {
  const CustomStringSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10))
  const CustomStringDatatype = Datatype('string', CustomStringSchema)

  const choiceWithOverride = DatatypeChoice.DatatypeChoice(
    'value',
    ['string', 'boolean'],
    [CustomStringDatatype]
  )
  const ChoiceWithOverride = Schema.Struct(choiceWithOverride.fields)
  const decode = Schema.decodeSync(ChoiceWithOverride)

  test('override schema is used for the specified type', () => {
    expect(() => decode({ ...choiceWithOverride.emptyEncoded, valueString: 'hello' })).not.toThrow()
    expect(() => decode({ ...choiceWithOverride.emptyEncoded, valueString: '' })).toThrow()
    expect(() =>
      decode({ ...choiceWithOverride.emptyEncoded, valueString: 'this is way too long' })
    ).toThrow()
  })

  test('non-overridden type uses default schema', () => {
    expect(() => decode({ ...choiceWithOverride.emptyEncoded, valueBoolean: true })).not.toThrow()
  })

  test('property: arbitrary respects override constraints', () => {
    const arb = Arbitrary.make(ChoiceWithOverride)
    fc.assert(
      fc.property(arb, (value) => {
        if (value.valueString !== null) {
          expect(value.valueString?.length).toBeGreaterThanOrEqual(1)
          expect(value.valueString?.length).toBeLessThanOrEqual(10)
        }
      })
    )
  })
})

// ---------------------------------------------------------------------------
// DatatypeChoice.cases
// ---------------------------------------------------------------------------

describe('DatatypeChoice.cases', () => {
  const valueChoice = DatatypeChoice.DatatypeChoice('value', ['string', 'boolean', 'integer'])
  const ValueChoice = Schema.Struct(valueChoice.fields)
  const decode = Schema.decodeSync(ValueChoice)

  test('strips prefix and uncapitalizes keys', () => {
    const v = decode({ ...valueChoice.emptyEncoded, valueString: 'hello' })
    const c = DatatypeChoice.cases('value', v)
    expect(c.string).toBe('hello')
  })

  test('unset fields are undefined', () => {
    const v = decode({ ...valueChoice.emptyEncoded, valueString: 'hello' })
    const c = DatatypeChoice.cases('value', v)
    expect(c.boolean).toBeNull()
    expect(c.integer).toBeNull()
  })

  test('works with boolean field', () => {
    const v = decode({ ...valueChoice.emptyEncoded, valueBoolean: true })
    const c = DatatypeChoice.cases('value', v)
    expect(c.boolean).toBe(true)
    expect(c.string).toBeNull()
  })

  test('ignores keys without the prefix', () => {
    const mixed = { valueString: 'hi', name: 'ignored' }
    const c = DatatypeChoice.cases('value', mixed)
    expect(c.string).toBe('hi')
    expect((c as Record<string, unknown>).name).toBeUndefined()
  })

  test('reveals every defined field (no mutual exclusion)', () => {
    const v = decode({ ...valueChoice.emptyEncoded, valueString: 'hi', valueBoolean: true })
    const c = DatatypeChoice.cases('value', v)
    expect(c.string).toBe('hi')
    expect(c.boolean).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DatatypeChoice.match
// ---------------------------------------------------------------------------

describe('DatatypeChoice.match', () => {
  const valueChoice = DatatypeChoice.DatatypeChoice('value', ['string', 'boolean', 'integer'])
  const ValueChoice = Schema.Struct(valueChoice.fields)
  const decode = Schema.decodeSync(ValueChoice)

  describe('exhaustive (no default)', () => {
    const format = (v: typeof ValueChoice.Type): string =>
      DatatypeChoice.match('value', v, {
        boolean: (b) => `bool:${b}`,
        integer: (n) => `int:${n}`,
        string: (s) => `str:${s}`,
      })

    test('matches string field', () => {
      expect(format(decode({ ...valueChoice.emptyEncoded, valueString: 'hi' }))).toBe('str:hi')
    })

    test('matches boolean field', () => {
      expect(format(decode({ ...valueChoice.emptyEncoded, valueBoolean: false }))).toBe(
        'bool:false'
      )
    })

    test('matches integer field', () => {
      expect(format(decode({ ...valueChoice.emptyEncoded, valueInteger: 42 }))).toBe('int:42')
    })

    test('throws when no field is defined and no default given', () => {
      expect(() => format(decode({ ...valueChoice.emptyEncoded }))).toThrow('no matcher handled')
    })
  })

  describe('partial with default', () => {
    test('matched tag uses its handler', () => {
      const v = decode({ ...valueChoice.emptyEncoded, valueString: 'hi' })
      const result = DatatypeChoice.match(
        'value',
        v,
        { string: (s) => s?.toUpperCase() },
        () => 'default'
      )
      expect(result).toBe('HI')
    })

    test('unmatched tag uses default', () => {
      const v = decode({ ...valueChoice.emptyEncoded, valueInteger: 99 })
      const result = DatatypeChoice.match(
        'value',
        v,
        { string: (s) => s?.toUpperCase() },
        () => 'default'
      )
      expect(result).toBe('default')
    })

    test('default fires when no field is set', () => {
      const v = decode({ ...valueChoice.emptyEncoded })
      const result = DatatypeChoice.match(
        'value',
        v,
        { string: (s) => s?.toUpperCase() },
        () => 'empty'
      )
      expect(result).toBe('empty')
    })

    test('default receives the full value', () => {
      const v = decode({ ...valueChoice.emptyEncoded, valueBoolean: true })
      const result = DatatypeChoice.match(
        'value',
        v,
        {
          string: (s) => {
            if (s === null) {
              return 'null'
            } else {
              return 'S'
            }
          },
        },
        (unmatched): string => {
          if (unmatched.valueBoolean) {
            return 'B'
          } else {
            return '?'
          }
        }
      )
      expect(result).toBe('B')
    })
  })

  describe('multiple fields defined', () => {
    test('picks the first matcher whose field is defined (insertion order)', () => {
      const v = { valueString: 'hi', valueBoolean: true, valueInteger: 0 }
      const result = DatatypeChoice.match('value', v, {
        boolean: (b) => `bool:${b}`,
        integer: (n) => `int:${n}`,
        string: (s) => `str:${s}`,
      })
      expect(result).toBe('bool:true')
    })

    test('skips matchers without a defined field', () => {
      const v = decode({ ...valueChoice.emptyEncoded, valueInteger: 7 })
      const result = DatatypeChoice.match('value', v, {
        boolean: (b) => `bool:${b}`,
        integer: (n) => `int:${n}`,
        string: (s) => `str:${s}`,
      })
      expect(result).toBe('int:7')
    })
  })
})
