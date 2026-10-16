import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
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

const pointKey: fc.Arbitrary<ObservationSeriesKey> = fc.record({
  kind: fc.constant('points' as const),
  system: nullableField,
  code: field,
  unit: nullableField,
})

const spanKey: fc.Arbitrary<ObservationSeriesKey> = fc.record({
  kind: fc.constant('spans' as const),
  system: nullableField,
  code: field,
})

/** Point-series and span-series keys alike, so each form is checked against the other. */
const observationKey: fc.Arbitrary<ObservationSeriesKey> = fc.oneof(pointKey, spanKey)

/**
 * The observation id exactly as shared links spell it — the grammar and
 * escaping written out independently of `SeriesId`, so the test fails if the
 * shared escaping ever drifts from what saved links carry.
 */
const savedLinkIdOf = (key: ObservationSeriesKey): string => {
  const escape = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|')
  const nullable = (value: string | null): string => (value === null ? '\\~' : escape(value))
  const head = `o:${nullable(key.system)}|${escape(key.code)}`
  return key.kind === 'points' ? `${head}|${nullable(key.unit)}` : `${head}|\\~|span`
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
      observationSeriesIdOf({
        kind: 'points',
        system: 'http://loinc.org',
        code: '2339-0',
        unit: 'mg/dL',
      })
    ).toBe('o:http://loinc.org|2339-0|mg/dL')
    expect(
      observationSeriesIdOf({ kind: 'points', system: null, code: 'Home glucose', unit: null })
    ).toBe('o:\\~|Home glucose|\\~')
    expect(
      observationSeriesIdOf({ kind: 'spans', system: 'https://pebble', code: 'HealthActivity' })
    ).toBe('o:https://pebble|HealthActivity|\\~|span')
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
    const withNull = observationSeriesIdOf({
      kind: 'points',
      system: null,
      code: 'glucose',
      unit: null,
    })
    const withEmpty = observationSeriesIdOf({
      kind: 'points',
      system: '',
      code: 'glucose',
      unit: '',
    })
    expect(withNull).not.toBe(withEmpty)
    expect(parseObservationSeriesId(withNull)).toEqual({
      kind: 'points',
      system: null,
      code: 'glucose',
      unit: null,
    })
    expect(parseObservationSeriesId(withEmpty)).toEqual({
      kind: 'points',
      system: '',
      code: 'glucose',
      unit: '',
    })
  })

  test('a literal backslash-tilde code is not read back as null', () => {
    const key: ObservationSeriesKey = { kind: 'points', system: null, code: '\\~', unit: null }
    expect(parseObservationSeriesId(observationSeriesIdOf(key))).toEqual(key)
  })

  test('malformed ids parse to null rather than throwing', () => {
    // Another prefix (a medication id included), wrong field count either
    // way, a dangling escape, a null marker in the never-nullable code slot,
    // and an escape the grammar never writes; and a four-field id that is not
    // the span form — a unit before the marker, another marker, five fields.
    for (const id of [
      '',
      'x:a|b|c',
      'm:insulin|mg',
      'o:a|b',
      'o:a|b|c|d',
      'o:a|b|c|span',
      'o:a|b|\\~|spans',
      'o:a|\\~|\\~|span',
      'o:a|b|\\~|span|e',
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
