import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  DEFAULT_RANGE,
  RANGE_PARAM,
  SERIES_PARAM,
  type Selection,
  decodeSelection,
  encodeSelection,
} from './selection-url.ts'
import { type SeriesKey, seriesId } from './series.ts'
import { RANGE_PRESETS } from './time-range.ts'

const RUNS = numRunsFor({ base: 200 })

const field = fc.oneof(fc.stringMatching(/^[|\\~a-z ]{0,10}$/), fc.string({ maxLength: 10 }))
const nullableField = fc.option(field, { nil: null })

const seriesKey: fc.Arbitrary<SeriesKey> = fc.oneof(
  fc.record({
    kind: fc.constant('observation' as const),
    system: nullableField,
    code: field,
    unit: nullableField,
  }),
  fc.record({ kind: fc.constant('medication' as const), name: field, unit: nullableField })
)

const selection: fc.Arbitrary<Selection> = fc.record({
  series: fc.array(seriesKey, { maxLength: 4 }),
  range: fc.constantFrom(...RANGE_PRESETS),
  patient: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
})

describe('encodeSelection / decodeSelection', () => {
  test('decode inverts encode for every selection', () => {
    fc.assert(
      fc.property(selection, (value) => {
        expect(decodeSelection(encodeSelection(value))).toEqual(value)
      }),
      { numRuns: RUNS }
    )
  })

  test('survives a round-trip through an actual URL query string', () => {
    fc.assert(
      fc.property(selection, (value) => {
        const query = encodeSelection(value).toString()
        expect(decodeSelection(new URLSearchParams(query))).toEqual(value)
      }),
      { numRuns: RUNS }
    )
  })

  test('series order is preserved — it is what decides axis sides', () => {
    fc.assert(
      fc.property(fc.array(seriesKey, { minLength: 2, maxLength: 4 }), (keys) => {
        const decoded = decodeSelection(
          encodeSelection({ series: keys, range: 'all', patient: null })
        )
        expect(decoded.series).toEqual(keys)
      }),
      { numRuns: RUNS }
    )
  })

  test('an absent patient stays absent rather than becoming an empty string', () => {
    const params = encodeSelection({ series: [], range: 'all', patient: null })
    expect(params.has('patient')).toBe(false)
    expect(decodeSelection(params).patient).toBeNull()
  })

  test('an empty-string patient is distinguishable from an absent one', () => {
    expect(
      decodeSelection(encodeSelection({ series: [], range: 'all', patient: '' })).patient
    ).toBe('')
  })

  describe('malformed input is dropped, never thrown', () => {
    test('unparseable series entries are skipped and the rest survive', () => {
      fc.assert(
        fc.property(seriesKey, fc.string(), (key, junk) => {
          const params = new URLSearchParams()
          params.append(SERIES_PARAM, junk)
          params.append(SERIES_PARAM, seriesId(key))
          const decoded = decodeSelection(params)
          // `junk` may happen to be a valid id, in which case it is kept too;
          // what must hold is that the good key is never lost.
          expect(decoded.series).toContainEqual(key)
        }),
        { numRuns: RUNS }
      )
    })

    test('an absent or unrecognised range falls back to the default', () => {
      fc.assert(
        fc.property(
          fc.string().filter((value) => !(RANGE_PRESETS as readonly string[]).includes(value)),
          (junk) => {
            const params = new URLSearchParams()
            params.set(RANGE_PARAM, junk)
            expect(decodeSelection(params).range).toBe(DEFAULT_RANGE)
          }
        ),
        { numRuns: RUNS }
      )
      expect(decodeSelection(new URLSearchParams()).range).toBe(DEFAULT_RANGE)
    })

    test('arbitrary query strings decode to something rather than throwing', () => {
      fc.assert(
        fc.property(fc.string(), (query) => {
          expect(() => decodeSelection(new URLSearchParams(query))).not.toThrow()
        }),
        { numRuns: RUNS }
      )
    })
  })
})
