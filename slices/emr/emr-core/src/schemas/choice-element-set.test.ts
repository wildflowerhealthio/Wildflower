import { Arbitrary, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { State } from '@livestore/livestore'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
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

describe('ChoiceElementSet.Columns', () => {
  describe('field naming', () => {
    test('capitalizes primitive names with the given prefix', () => {
      const cols = ChoiceElementSet.Columns('value', ['string', 'boolean', 'integer'])
      expect(Object.keys(cols).toSorted()).toEqual(
        ['valueBoolean', 'valueInteger', 'valueString'].toSorted()
      )
    })

    test('preserves already-capitalized complex datatype names', () => {
      const cols = ChoiceElementSet.Columns('value', ['Quantity', 'CodeableConcept', 'Period'])
      expect(Object.keys(cols).toSorted()).toEqual(
        ['valueCodeableConcept', 'valuePeriod', 'valueQuantity'].toSorted()
      )
    })

    test('applies arbitrary prefix', () => {
      const cols = ChoiceElementSet.Columns('effective', ['dateTime', 'Period'])
      expect(Object.keys(cols).toSorted()).toEqual(
        ['effectiveDateTime', 'effectivePeriod'].toSorted()
      )
    })
  })

  describe('column DbType selection', () => {
    const cols = ChoiceElementSet.Columns('value', [
      'boolean',
      'integer',
      'positiveInt',
      'unsignedInt',
      'decimal',
      'string',
      'code',
      'dateTime',
      'time',
      'Quantity',
      'CodeableConcept',
    ])

    test('boolean lands in an integer column (livestore stores booleans as 0/1)', () => {
      expect(cols.valueBoolean.columnType).toBe('integer')
    })

    test('integer-family primitives land in integer columns', () => {
      expect(cols.valueInteger.columnType).toBe('integer')
      expect(cols.valuePositiveInt.columnType).toBe('integer')
      expect(cols.valueUnsignedInt.columnType).toBe('integer')
    })

    test('decimal lands in a real column', () => {
      expect(cols.valueDecimal.columnType).toBe('real')
    })

    test('text-encoded primitives land in text columns', () => {
      expect(cols.valueString.columnType).toBe('text')
      expect(cols.valueCode.columnType).toBe('text')
      expect(cols.valueDateTime.columnType).toBe('text')
      expect(cols.valueTime.columnType).toBe('text')
    })

    test('complex datatypes land in text columns (livestore json is text-backed)', () => {
      expect(cols.valueQuantity.columnType).toBe('text')
      expect(cols.valueCodeableConcept.columnType).toBe('text')
    })

    test('all emitted columns are nullable, with no default and no primaryKey', () => {
      for (const col of Object.values(cols)) {
        expect(col.nullable).toBe(true)
        expect(Option.isNone(col.default)).toBe(true)
        expect(col.primaryKey).toBe(false)
      }
    })
  })

  describe('column schema behavior', () => {
    const cols = ChoiceElementSet.Columns('value', [
      'boolean',
      'integer',
      'string',
      'dateTime',
      'time',
      'Quantity',
    ])

    test('valueBoolean decodes 0/1 as false/true, accepts null', () => {
      const decode = Schema.decodeUnknownSync(cols.valueBoolean.schema)
      expect(decode(1)).toBe(true)
      expect(decode(0)).toBe(false)
      expect(decode(null)).toBeNull()
    })

    test('valueInteger rejects non-integers (Schema.Int)', () => {
      const decode = Schema.decodeUnknownEither(cols.valueInteger.schema)
      expect(decode(42)).toEqual(Either.right(42))
      expect(decode(null)).toEqual(Either.right(null))
      expect(Either.isLeft(decode(1.5))).toBe(true)
    })

    test('valueString round-trips strings and null', () => {
      const decode = Schema.decodeUnknownSync(cols.valueString.schema)
      expect(decode('hello')).toBe('hello')
      expect(decode(null)).toBeNull()
    })

    test('valueDateTime decodes ISO 8601 strings to DateTime.Utc, accepts null', () => {
      const decode = Schema.decodeUnknownSync(cols.valueDateTime.schema)
      const decoded = decode('2024-01-15T12:34:56Z')
      expect(DateTime.isDateTime(decoded)).toBe(true)
      expect(decode(null)).toBeNull()
    })

    test('valueTime accepts a valid hh:mm:ss string and rejects garbage', () => {
      const decode = Schema.decodeUnknownEither(cols.valueTime.schema)
      expect(decode('12:34:56')).toEqual(Either.right('12:34:56'))
      expect(decode(null)).toEqual(Either.right(null))
      expect(Either.isLeft(decode('not-a-time'))).toBe(true)
    })

    test('valueQuantity (complex) decodes a JSON string via the lazy registry', () => {
      // Quantity is currently unregistered in the datatype registry, so the
      // lazy suspend resolves to FallbackSchema (PermissivePassthrough) and
      // any JSON-decodable value round-trips losslessly.
      const decode = Schema.decodeUnknownSync(cols.valueQuantity.schema)
      const encode = Schema.encodeSync(cols.valueQuantity.schema)
      expect(decode('{"value":42,"unit":"mg"}')).toEqual({ value: 42, unit: 'mg' })
      expect(decode(null)).toBeNull()
      expect(encode({ value: 42, unit: 'mg' })).toBe('{"value":42,"unit":"mg"}')
    })
  })

  describe('integration with State.SQLite.table + makeRowSchemas', () => {
    const columns = {
      id: State.SQLite.text({ primaryKey: true }),
      ...ChoiceElementSet.Columns('value', [
        'string',
        'boolean',
        'integer',
        'dateTime',
        'Quantity',
      ]),
    } as const

    test('builds a livestore table without error', () => {
      const table = State.SQLite.table({ name: 'TestChoice', columns })
      expect(table.sqliteDef.name).toBe('TestChoice')
      const colNames = Object.keys(table.sqliteDef.columns)
      expect(colNames).toContain('valueString')
      expect(colNames).toContain('valueBoolean')
      expect(colNames).toContain('valueInteger')
      expect(colNames).toContain('valueDateTime')
      expect(colNames).toContain('valueQuantity')
    })

    test('makeRowSchemas yields a Schema.Struct that round-trips a row', () => {
      const { RowSchema } = makeRowSchemas(columns, { name: 'TestChoice' })
      const row = {
        id: 'row-1',
        valueString: 'hello',
        valueBoolean: null,
        valueInteger: null,
        valueDateTime: null,
        valueQuantity: null,
      }
      const encoded = Schema.encodeSync(RowSchema)(row)
      const decoded = Schema.decodeSync(RowSchema)(encoded)
      expect(decoded.valueString).toBe('hello')
      expect(decoded.valueBoolean).toBeNull()
      expect(decoded.valueInteger).toBeNull()
    })

    test('makeRowSchemas round-trips a complex (Quantity) value through the json column', () => {
      const { RowSchema } = makeRowSchemas(columns, { name: 'TestChoice' })
      const row = {
        id: 'row-2',
        valueString: null,
        valueBoolean: null,
        valueInteger: null,
        valueDateTime: null,
        valueQuantity: { value: 99, unit: 'kg' },
      }
      const encoded = Schema.encodeSync(RowSchema)(row)
      // valueQuantity is encoded as a JSON string by the json column
      expect(typeof encoded.valueQuantity).toBe('string')
      const decoded = Schema.decodeSync(RowSchema)(encoded)
      expect(decoded.valueQuantity).toEqual({ value: 99, unit: 'kg' })
    })
  })
})
