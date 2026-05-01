import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as ChoiceElementSet from './choice-element-set.ts'

// ---------------------------------------------------------------------------
// ChoiceElementSet.SchemaFields — flat struct factory
// ---------------------------------------------------------------------------

describe('ChoiceElementSet.SchemaFields', () => {
  const valueChoiceFields = ChoiceElementSet.SchemaFields('value', ['string', 'boolean', 'integer'])
  const emptyValueChoices = ChoiceElementSet.empty('value', ['string', 'boolean', 'integer'])
  const ValueChoice = Schema.Struct(valueChoiceFields)
  const decode = Schema.decodeSync(ValueChoice)
  const decodeUnknown = Schema.decodeUnknownSync(ValueChoice)
  const encode = Schema.encodeSync(ValueChoice)

  describe('schema structure', () => {
    test('decodes a valueString field', () => {
      const result = decode({ ...emptyValueChoices, valueString: 'hello' })
      expect(result).toEqual({ valueString: 'hello', valueBoolean: null, valueInteger: null })
    })

    test('decodes a valueBoolean field', () => {
      const result = decode({ ...emptyValueChoices, valueBoolean: true })
      expect(result).toEqual({ valueBoolean: true, valueInteger: null, valueString: null })
    })

    test('decodes a valueInteger field', () => {
      const result = decode({ ...emptyValueChoices, valueInteger: 42 })
      expect(result).toEqual({ valueInteger: 42, valueBoolean: null, valueString: null })
    })

    test('accepts an empty object (all fields optional)', () => {
      const result = decode({ ...emptyValueChoices })
      expect(result).toEqual({
        valueBoolean: null,
        valueInteger: null,
        valueString: null,
      })
    })

    test('accepts multiple fields simultaneously (no mutual exclusion)', () => {
      const result = decode({
        ...emptyValueChoices,
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
      const Choice = ChoiceElementSet.SchemaFields('value', ['Quantity', 'Reference'])
      expect(Object.keys(Choice).toSorted()).toEqual(['valueQuantity', 'valueReference'].toSorted())
    })

    test('applies arbitrary prefix', () => {
      const Effective = ChoiceElementSet.SchemaFields('effective', ['dateTime', 'Period'])
      expect(Object.keys(Effective).toSorted()).toEqual(
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
      const result = decodeResource({ name: 'test', ...emptyValueChoices, valueInteger: 99 })
      expect(result.valueInteger).toBe(99)
      expect(result.valueString).toBeNull()
    })

    test('decodes with every choice field absent', () => {
      const result = decodeResource({ name: 'test', ...emptyValueChoices })
      expect(result.valueString).toBeNull()
      expect(result.valueBoolean).toBeNull()
      expect(result.valueInteger).toBeNull()
    })
  })
})
