import { StructNoContext } from '@wildflowerhealthio/kitchen-sink/schema'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Predicate, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as FhirString from './fhir-string.ts'

// An element struct with one field of each kind, the way a datatype embeds them.
const Element = StructNoContext({
  text: FhirString.Optional,
  given: Schema.optionalWith(FhirString.Array, { default: () => [] as readonly string[] }),
})

const decodeElement = Schema.decodeUnknownSync(Element)
const encodeElement = Schema.encodeSync(Element)

const blanks = ['', ' ', '   ', '\n\t', ' '] as const

// Wire strings that are blank about half the time.
const maybeBlankWireString = fc.oneof(
  fc.constantFrom(...blanks),
  fc.stringMatching(/^\s*$/),
  fc.string()
)

describe('FhirString.Optional', () => {
  test.each(blanks)('decodes %j to null', (blank) => {
    expect(decodeElement({ text: blank }).text).toBeNull()
  })

  test('decodes an absent value to null', () => {
    expect(decodeElement({}).text).toBeNull()
  })

  test('round-trips a value with surrounding whitespace verbatim', () => {
    const decoded = decodeElement({ text: ' a ' })
    expect(decoded.text).toBe(' a ')
    expect(encodeElement(decoded)).toEqual({ text: ' a ', given: [] })
  })

  test.each(['', '  '])('fails to encode %j', (blank) => {
    expect(() => encodeElement({ text: blank, given: [] })).toThrow()
  })

  test('encodes null as absent', () => {
    // `OrNullAsOptional` writes absent as an `undefined` key, which JSON drops.
    expect(JSON.stringify(encodeElement({ text: null, given: [] }))).toBe('{"given":[]}')
  })
})

describe('FhirString.Schema', () => {
  test.each(blanks)('fails to decode %j', (blank) => {
    expect(() => Schema.decodeUnknownSync(FhirString.Schema)(blank)).toThrow()
  })

  test.each(blanks)('fails to encode %j', (blank) => {
    expect(() => Schema.encodeSync(FhirString.Schema)(blank)).toThrow()
  })

  test('round-trips a value with surrounding whitespace verbatim', () => {
    expect(Schema.decodeUnknownSync(FhirString.Schema)(' a ')).toBe(' a ')
    expect(Schema.encodeSync(FhirString.Schema)(' a ')).toBe(' a ')
  })
})

describe('FhirString.BlankAsNull', () => {
  test('fails to encode null, which has no wire string', () => {
    expect(() => Schema.encodeSync(FhirString.BlankAsNull)(null)).toThrow()
  })
})

describe('FhirString.Array', () => {
  test('drops blank items on decode', () => {
    expect(Schema.decodeUnknownSync(FhirString.Array)(['', 'Ann', ' '])).toEqual(['Ann'])
  })

  test('fails to encode a blank item', () => {
    expect(() => Schema.encodeSync(FhirString.Array)(['Ann', ''])).toThrow()
  })
})

describe('FhirString properties', () => {
  test('property: every value the Schema arbitrary yields is non-blank', () => {
    fc.assert(
      fc.property(Arbitrary.make(FhirString.Schema), (value) => {
        expect(value).toMatch(/\S/)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: Schema round-trips decoded → wire → decoded', () => {
    fc.assert(
      fc.property(Arbitrary.make(FhirString.Schema), (value) => {
        const wire = Schema.encodeSync(FhirString.Schema)(value)
        expect(wire).toBe(value)
        expect(Schema.decodeUnknownSync(FhirString.Schema)(wire)).toBe(value)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: Optional round-trips decoded → wire → decoded', () => {
    fc.assert(
      fc.property(Arbitrary.make(Element), (element) => {
        expect(decodeElement(encodeElement(element))).toEqual(element)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: Array round-trips decoded → wire → decoded', () => {
    fc.assert(
      fc.property(Arbitrary.make(FhirString.Array), (items) => {
        const wire = Schema.encodeSync(FhirString.Array)(items)
        expect(Schema.decodeUnknownSync(FhirString.Array)(wire)).toEqual(items)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: normalising wire JSON is idempotent', () => {
    fc.assert(
      fc.property(
        fc.record(
          { text: maybeBlankWireString, given: fc.array(maybeBlankWireString, { maxLength: 4 }) },
          { requiredKeys: [] }
        ),
        (wire) => {
          const once = encodeElement(decodeElement(wire))
          const twice = encodeElement(decodeElement(once))
          expect(twice).toEqual(once)
          const written = [once.text, ...(once.given ?? [])].filter(Predicate.isString)
          expect(written.filter((value) => !/\S/.test(value))).toEqual([])
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
