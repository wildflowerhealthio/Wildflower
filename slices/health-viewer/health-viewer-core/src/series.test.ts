import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { type SeriesKey, parseSeriesId, seriesId } from './series.ts'

const RUNS = numRunsFor({ base: 200 })

/**
 * Text that leans on the id grammar: separators, escapes, and the null
 * marker's own characters, so the escaping is exercised rather than avoided.
 */
const nasty = fc.stringMatching(/^[|\\~a-z ]{0,12}$/)
const field = fc.oneof(nasty, fc.string({ maxLength: 12 }))
const nullableField = fc.option(field, { nil: null })

const observationKey: fc.Arbitrary<SeriesKey> = fc.record({
  kind: fc.constant('observation' as const),
  system: nullableField,
  code: field,
  unit: nullableField,
})

const medicationKey: fc.Arbitrary<SeriesKey> = fc.record({
  kind: fc.constant('medication' as const),
  name: field,
  unit: nullableField,
})

const seriesKey: fc.Arbitrary<SeriesKey> = fc.oneof(observationKey, medicationKey)

describe('seriesId / parseSeriesId', () => {
  test('parseSeriesId inverts seriesId for every key', () => {
    fc.assert(
      fc.property(seriesKey, (key) => {
        expect(parseSeriesId(seriesId(key))).toEqual(key)
      }),
      { numRuns: RUNS }
    )
  })

  test('distinct keys never share an id', () => {
    fc.assert(
      fc.property(seriesKey, seriesKey, (left, right) => {
        if (seriesId(left) === seriesId(right)) expect(left).toEqual(right)
      }),
      { numRuns: RUNS }
    )
  })

  test('a null field is distinguishable from the empty string', () => {
    const withNull = seriesId({ kind: 'medication', name: 'insulin', unit: null })
    const withEmpty = seriesId({ kind: 'medication', name: 'insulin', unit: '' })
    expect(withNull).not.toBe(withEmpty)
    expect(parseSeriesId(withNull)).toEqual({ kind: 'medication', name: 'insulin', unit: null })
    expect(parseSeriesId(withEmpty)).toEqual({ kind: 'medication', name: 'insulin', unit: '' })
  })

  test('a literal backslash-tilde code is not read back as null', () => {
    const key: SeriesKey = { kind: 'medication', name: '\\~', unit: null }
    expect(parseSeriesId(seriesId(key))).toEqual(key)
  })

  test('malformed ids parse to null rather than throwing', () => {
    // Unknown prefix, wrong field count either way, dangling escape, and a
    // null marker in a slot that is never nullable.
    for (const id of ['', 'x:a|b', 'o:a|b', 'o:a|b|c|d', 'm:a', 'm:a|b|c', 'm:a\\', 'm:\\~|mg']) {
      expect(parseSeriesId(id)).toBeNull()
    }
  })

  test('arbitrary strings never throw', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(() => parseSeriesId(id)).not.toThrow()
      }),
      { numRuns: RUNS }
    )
  })
})
