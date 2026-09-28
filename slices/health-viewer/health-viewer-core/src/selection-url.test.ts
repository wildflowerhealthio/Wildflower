import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { medicationSource } from 'health-viewer-medications'
import { observationSource } from 'health-viewer-observations'
import {
  DEFAULT_RANGE,
  RANGE_PARAM,
  SERIES_PARAM,
  type Selection,
  decodeSelection,
  encodeSelection,
} from './selection-url.ts'

import { RANGE_PRESETS } from './time-range.ts'

const RUNS = numRunsFor({ base: 200 })

const field = fc.oneof(fc.stringMatching(/^[|\\~a-z ]{0,10}$/), fc.string({ maxLength: 10 }))
const nullableField = fc.option(field, { nil: null })

/** An id some assembled source can read: an observation's or a medication's. */
const seriesIdArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .record({ system: nullableField, code: field, unit: nullableField })
    .map(observationSource.seriesIdOf),
  fc
    .record({
      medication: field,
      doseUnit: nullableField,
      doseBasis: fc.constantFrom('administration' as const, 'd' as const),
    })
    .map(medicationSource.seriesIdOf)
)

const selection: fc.Arbitrary<Selection> = fc.record({
  series: fc.array(seriesIdArb, { maxLength: 4 }),
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
      fc.property(fc.array(seriesIdArb, { minLength: 2, maxLength: 4 }), (ids) => {
        const decoded = decodeSelection(
          encodeSelection({ series: ids, range: 'all', patient: null })
        )
        expect(decoded.series).toEqual(ids)
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
        fc.property(seriesIdArb, fc.string(), (id, junk) => {
          const params = new URLSearchParams()
          params.append(SERIES_PARAM, junk)
          params.append(SERIES_PARAM, id)
          const decoded = decodeSelection(params)
          // `junk` may happen to be a valid id, in which case it is kept too;
          // what must hold is that the good id is never lost.
          expect(decoded.series).toContain(id)
        }),
        { numRuns: RUNS }
      )
    })

    test('an id no assembled source reads is dropped', () => {
      const params = new URLSearchParams()
      for (const id of ['m:insulin|mg', 'm:insulin|mg|day', 'x:a|b|c', 'o:a|b', 'o:a\\x|b|c']) {
        params.append(SERIES_PARAM, id)
      }
      expect(decodeSelection(params).series).toEqual([])
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
