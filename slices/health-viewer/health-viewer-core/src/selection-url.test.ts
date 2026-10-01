import * as fc from 'fast-check'
import { ValueAxis } from 'health-viewer-fundamentals'
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
  withSelection,
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
  series: fc.uniqueArray(seriesIdArb, { maxLength: ValueAxis.CAP }),
  range: fc.constantFrom(...RANGE_PRESETS),
})

/** Query parameters the page's URL carries beside the selection, e.g. `?patient=`. */
const otherParams: fc.Arbitrary<URLSearchParams> = fc
  .array(
    fc.tuple(
      fc.string({ maxLength: 8 }).filter((key) => key !== SERIES_PARAM && key !== RANGE_PARAM),
      fc.string({ maxLength: 8 })
    ),
    { maxLength: 6 }
  )
  .map((entries) => new URLSearchParams(entries))

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
      fc.property(
        fc.uniqueArray(seriesIdArb, { minLength: 2, maxLength: ValueAxis.CAP }),
        (ids) => {
          const decoded = decodeSelection(encodeSelection({ series: ids, range: 'all' }))
          expect(decoded.series).toEqual(ids)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test.each(RANGE_PRESETS)('the %s preset is written as its own name and read back', (range) => {
    const query = encodeSelection({ series: [], range }).toString()
    expect(query).toBe(`${RANGE_PARAM}=${range}`)
    expect(decodeSelection(new URLSearchParams(query)).range).toBe(range)
  })

  test('withSelection replaces the selection and keeps every other key as it was', () => {
    fc.assert(
      fc.property(otherParams, selection, selection, (others, earlier, later) => {
        const written = withSelection(withSelection(others, earlier), later)
        expect(decodeSelection(written)).toEqual(later)
        written.delete(SERIES_PARAM)
        written.delete(RANGE_PARAM)
        expect(written.toString()).toBe(others.toString())
      }),
      { numRuns: RUNS }
    )
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

    test('a repeated id keeps its first place and nothing else', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(seriesIdArb, { minLength: 1, maxLength: ValueAxis.CAP }),
          (ids) => {
            const params = new URLSearchParams()
            for (const id of [...ids, ...ids.toReversed()]) params.append(SERIES_PARAM, id)
            expect(decodeSelection(params).series).toEqual(ids)
          }
        ),
        { numRuns: RUNS }
      )
    })

    test('only the first ValueAxis.CAP ids are kept', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(seriesIdArb, {
            minLength: ValueAxis.CAP + 1,
            maxLength: ValueAxis.CAP + 4,
          }),
          (ids) => {
            const params = new URLSearchParams()
            for (const id of ids) params.append(SERIES_PARAM, id)
            expect(decodeSelection(params).series).toEqual(ids.slice(0, ValueAxis.CAP))
          }
        ),
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
