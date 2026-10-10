import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as SeriesId from './series-id.ts'

const RUNS = numRunsFor({ base: 200 })

/**
 * Text that leans on the id grammar: separators, escapes, and the null
 * marker's own characters, so the escaping is exercised rather than avoided.
 */
const nasty = fc.stringMatching(/^[|\\~:a-z ]{0,12}$/)
const field = fc.oneof(nasty, fc.string({ maxLength: 12 }))
const fieldsArb = fc.array(fc.option(field, { nil: null }), { minLength: 1, maxLength: 4 })
const prefixArb = fc.constantFrom('o', 'm', 'x')

describe('SeriesId.fromFields / toFields', () => {
  test('toFields inverts fromFields for every non-empty field list', () => {
    fc.assert(
      fc.property(prefixArb, fieldsArb, (prefix, fields) => {
        expect(SeriesId.toFields(prefix, SeriesId.fromFields(prefix, fields))).toEqual(fields)
      }),
      { numRuns: RUNS }
    )
  })

  test('an id that parses renders back to exactly itself', () => {
    fc.assert(
      fc.property(
        fc.oneof(nasty, fc.string()).map((body) => `o:${body}`),
        (id) => {
          const fields = SeriesId.toFields('o', id)
          if (fields !== null) expect(SeriesId.fromFields('o', fields)).toBe(id)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('distinct field lists never share an id', () => {
    fc.assert(
      fc.property(fieldsArb, fieldsArb, (left, right) => {
        if (SeriesId.fromFields('o', left) === SeriesId.fromFields('o', right)) {
          expect(left).toEqual(right)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('the escaping is byte-for-byte the one shared links already carry', () => {
    expect(SeriesId.fromFields('o', ['http://loinc.org', '2339-0', 'mg/dL'])).toBe(
      'o:http://loinc.org|2339-0|mg/dL'
    )
    expect(SeriesId.fromFields('o', [null, 'a|b\\c', null])).toBe('o:\\~|a\\|b\\\\c|\\~')
    expect(SeriesId.fromFields('o', ['', '\\~', ''])).toBe('o:|\\\\~|')
  })

  test('a null field is distinguishable from the empty string', () => {
    const withNull = SeriesId.fromFields('m', ['insulin', null])
    const withEmpty = SeriesId.fromFields('m', ['insulin', ''])
    expect(withNull).not.toBe(withEmpty)
    expect(SeriesId.toFields('m', withNull)).toEqual(['insulin', null])
    expect(SeriesId.toFields('m', withEmpty)).toEqual(['insulin', ''])
  })

  test('a literal backslash-tilde field is not read back as null', () => {
    expect(SeriesId.toFields('m', SeriesId.fromFields('m', ['\\~']))).toEqual(['\\~'])
  })

  test('an id under another prefix, or none, is not read', () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        expect(SeriesId.toFields('m', SeriesId.fromFields('o', fields))).toBeNull()
      }),
      { numRuns: RUNS }
    )
    for (const id of ['', 'o', 'oo:a', ':a', 'o;a']) expect(SeriesId.toFields('o', id)).toBeNull()
  })

  test('spellings fromFields never writes are rejected rather than read loosely', () => {
    // A dangling escape, an escape of an ordinary character, a bare null
    // marker inside a longer field.
    for (const id of ['o:a\\', 'o:a\\x|b', 'o:a\\~b|c', 'o:\\~\\~']) {
      expect(SeriesId.toFields('o', id)).toBeNull()
    }
  })

  test('arbitrary strings never throw', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(() => SeriesId.toFields('o', id)).not.toThrow()
      }),
      { numRuns: RUNS }
    )
  })
})
