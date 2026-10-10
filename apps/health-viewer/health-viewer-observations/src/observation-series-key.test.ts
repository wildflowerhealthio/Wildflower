import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  type ObservationSeriesKey,
  observationSeriesIdOf,
  parseObservationSeriesId,
} from './observation-series-key.ts'

const RUNS = numRunsFor({ base: 200 })

/**
 * Text that leans on the id grammar: separators, escapes, and the null
 * marker's own characters, so the escaping is exercised rather than avoided.
 */
const nasty = fc.stringMatching(/^[|\\~a-z ]{0,12}$/)
const field = fc.oneof(nasty, fc.string({ maxLength: 12 }))
const nullableField = fc.option(field, { nil: null })

const observationKey: fc.Arbitrary<ObservationSeriesKey> = fc.record({
  system: nullableField,
  code: field,
  unit: nullableField,
})

/**
 * The observation id exactly as shared links have always spelled it — the
 * grammar and escaping written out independently of `SeriesId`, so the test
 * fails if the shared escaping ever drifts from what saved links carry.
 */
const savedLinkIdOf = (key: ObservationSeriesKey): string => {
  const escape = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|')
  const nullable = (value: string | null): string => (value === null ? '\\~' : escape(value))
  return `o:${nullable(key.system)}|${escape(key.code)}|${nullable(key.unit)}`
}

describe('observationSeriesIdOf / parseObservationSeriesId', () => {
  test('ids are byte-for-byte the ones shared links already carry', () => {
    fc.assert(
      fc.property(observationKey, (key) => {
        expect(observationSeriesIdOf(key)).toBe(savedLinkIdOf(key))
      }),
      { numRuns: RUNS }
    )
    expect(
      observationSeriesIdOf({ system: 'http://loinc.org', code: '2339-0', unit: 'mg/dL' })
    ).toBe('o:http://loinc.org|2339-0|mg/dL')
    expect(observationSeriesIdOf({ system: null, code: 'Home glucose', unit: null })).toBe(
      'o:\\~|Home glucose|\\~'
    )
  })

  test('parseObservationSeriesId inverts observationSeriesIdOf for every key', () => {
    fc.assert(
      fc.property(observationKey, (key) => {
        expect(parseObservationSeriesId(observationSeriesIdOf(key))).toEqual(key)
      }),
      { numRuns: RUNS }
    )
  })

  test('distinct keys never share an id', () => {
    fc.assert(
      fc.property(observationKey, observationKey, (left, right) => {
        if (observationSeriesIdOf(left) === observationSeriesIdOf(right)) {
          expect(left).toEqual(right)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a null field is distinguishable from the empty string', () => {
    const withNull = observationSeriesIdOf({ system: null, code: 'glucose', unit: null })
    const withEmpty = observationSeriesIdOf({ system: '', code: 'glucose', unit: '' })
    expect(withNull).not.toBe(withEmpty)
    expect(parseObservationSeriesId(withNull)).toEqual({
      system: null,
      code: 'glucose',
      unit: null,
    })
    expect(parseObservationSeriesId(withEmpty)).toEqual({ system: '', code: 'glucose', unit: '' })
  })

  test('a literal backslash-tilde code is not read back as null', () => {
    const key: ObservationSeriesKey = { system: null, code: '\\~', unit: null }
    expect(parseObservationSeriesId(observationSeriesIdOf(key))).toEqual(key)
  })

  test('malformed ids parse to null rather than throwing', () => {
    // Another prefix (a medication id included), wrong field count either
    // way, a dangling escape, a null marker in the never-nullable code slot,
    // and an escape the grammar never writes.
    for (const id of [
      '',
      'x:a|b|c',
      'm:insulin|mg',
      'o:a|b',
      'o:a|b|c|d',
      'o:a|b|c\\',
      'o:a|\\~|c',
      'o:a\\x|b|c',
    ]) {
      expect(parseObservationSeriesId(id)).toBeNull()
    }
  })

  test('arbitrary strings never throw', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(() => parseObservationSeriesId(id)).not.toThrow()
      }),
      { numRuns: RUNS }
    )
  })
})
