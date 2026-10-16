import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  DOSE_BASES,
  type MedicationSeriesKey,
  medicationSeriesIdOf,
  parseMedicationSeriesId,
} from './medication-series-key.ts'

const RUNS = numRunsFor({ base: 200 })

/**
 * Text that leans on the id grammar: separators, escapes, the null marker's
 * own characters and the unnamed fallback's `#`, so the escaping is exercised
 * rather than avoided.
 */
const nasty = fc.stringMatching(/^[|\\~#a-z ]{0,12}$/)
const field = fc.oneof(nasty, fc.string({ maxLength: 12 }))

const medicationKey: fc.Arbitrary<MedicationSeriesKey> = fc.record({
  medication: field,
  doseUnit: fc.option(field, { nil: null }),
  doseBasis: fc.constantFrom(...DOSE_BASES),
})

/**
 * The medication id as shared links spell it — the grammar and escaping
 * written out independently of `SeriesId`, so the test fails if the shared
 * escaping ever drifts from what saved links carry.
 */
const savedLinkIdOf = (key: MedicationSeriesKey): string => {
  const escape = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|')
  const nullable = (value: string | null): string => (value === null ? '\\~' : escape(value))
  return `m:${escape(key.medication)}|${nullable(key.doseUnit)}|${key.doseBasis}`
}

describe('medicationSeriesIdOf / parseMedicationSeriesId', () => {
  test('ids are byte-for-byte the grammar shared links carry', () => {
    fc.assert(
      fc.property(medicationKey, (key) => {
        expect(medicationSeriesIdOf(key)).toBe(savedLinkIdOf(key))
      }),
      { numRuns: RUNS }
    )
    expect(
      medicationSeriesIdOf({ medication: 'metformin', doseUnit: 'mg', doseBasis: 'administration' })
    ).toBe('m:metformin|mg|administration')
    expect(medicationSeriesIdOf({ medication: '#mr-1', doseUnit: null, doseBasis: 'd' })).toBe(
      'm:#mr-1|\\~|d'
    )
  })

  test('parseMedicationSeriesId inverts medicationSeriesIdOf for every key', () => {
    fc.assert(
      fc.property(medicationKey, (key) => {
        expect(parseMedicationSeriesId(medicationSeriesIdOf(key))).toEqual(key)
      }),
      { numRuns: RUNS }
    )
  })

  test('distinct keys never share an id', () => {
    fc.assert(
      fc.property(medicationKey, medicationKey, (left, right) => {
        if (medicationSeriesIdOf(left) === medicationSeriesIdOf(right)) {
          expect(left).toEqual(right)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a null dose unit is distinguishable from the empty string', () => {
    const withNull = medicationSeriesIdOf({ medication: 'x', doseUnit: null, doseBasis: 'd' })
    const withEmpty = medicationSeriesIdOf({ medication: 'x', doseUnit: '', doseBasis: 'd' })
    expect(withNull).not.toBe(withEmpty)
    expect(parseMedicationSeriesId(withEmpty)).toEqual({
      medication: 'x',
      doseUnit: '',
      doseBasis: 'd',
    })
  })

  test('malformed ids parse to null rather than throwing', () => {
    // Another prefix (an observation id included), wrong field count either
    // way, a dangling escape, a null marker in the never-nullable medication
    // slot, a null or unknown basis, and an escape the grammar never writes.
    for (const id of [
      '',
      'x:a|mg|d',
      'o:\\~|code|mg',
      'm:insulin|mg',
      'm:a|mg|d|e',
      'm:a|mg|d\\',
      'm:\\~|mg|d',
      'm:a|mg|\\~',
      'm:a|mg|day',
      'm:a|mg|D',
      'm:a\\x|mg|d',
    ]) {
      expect(parseMedicationSeriesId(id)).toBeNull()
    }
  })

  test('arbitrary strings never throw, and any that parse are canonical', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          nasty.map((body) => `m:${body}`)
        ),
        (id) => {
          const key = parseMedicationSeriesId(id)
          if (key !== null) expect(medicationSeriesIdOf(key)).toBe(id)
        }
      ),
      { numRuns: RUNS }
    )
  })
})
