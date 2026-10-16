import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { SpanSeries, ValueAxis } from '@wildflowerhealthio/plots-fundamentals'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { medicationSource } from '@wildflowerhealthio/plots-medications'
import { observationSource } from '@wildflowerhealthio/plots-observations'
import {
  DEFAULT_RANGE,
  RANGE_PARAM,
  SERIES_PARAM,
  type Selection,
  capIsFull,
  decodeSelection,
  encodeSelection,
  selectionCapsOf,
  withSelection,
} from './selection-url.ts'

import { RANGE_PRESETS } from './time-range.ts'

const RUNS = numRunsFor({ base: 200 })

const field = fc.oneof(fc.stringMatching(/^[|\\~a-z ]{0,10}$/), fc.string({ maxLength: 10 }))
const nullableField = fc.option(field, { nil: null })

/** An id of a series drawn against a value axis: an observation's point series or a medication's. */
const seriesIdArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .record({
      kind: fc.constant('points' as const),
      system: nullableField,
      code: field,
      unit: nullableField,
    })
    .map(observationSource.seriesIdOf),
  fc
    .record({
      medication: field,
      doseUnit: nullableField,
      doseBasis: fc.constantFrom('administration' as const, 'd' as const),
    })
    .map(medicationSource.seriesIdOf)
)

/** An id of an observation span series, drawn as a lane. */
const spanSeriesIdArb: fc.Arbitrary<string> = fc
  .record({ kind: fc.constant('spans' as const), system: nullableField, code: field })
  .map(observationSource.seriesIdOf)

/**
 * A selection within both caps: up to `ValueAxis.CAP` value series and up to
 * `SpanSeries.LANE_CAP` span series, interleaved in any order.
 */
const selection: fc.Arbitrary<Selection> = fc.record({
  series: fc
    .tuple(
      fc.uniqueArray(seriesIdArb, { maxLength: ValueAxis.CAP }),
      fc.uniqueArray(spanSeriesIdArb, { maxLength: SpanSeries.LANE_CAP })
    )
    .chain(([valueIds, spanIds]) =>
      fc.shuffledSubarray([...valueIds, ...spanIds], {
        minLength: valueIds.length + spanIds.length,
      })
    ),
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

    test('only the first SpanSeries.LANE_CAP span ids are kept, beside the value ids', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(seriesIdArb, { maxLength: ValueAxis.CAP }),
          fc.uniqueArray(spanSeriesIdArb, {
            minLength: SpanSeries.LANE_CAP + 1,
            maxLength: SpanSeries.LANE_CAP + 3,
          }),
          (valueIds, spanIds) => {
            const params = new URLSearchParams()
            for (const id of [...spanIds, ...valueIds]) params.append(SERIES_PARAM, id)
            expect(decodeSelection(params).series).toEqual([
              ...spanIds.slice(0, SpanSeries.LANE_CAP),
              ...valueIds,
            ])
          }
        ),
        { numRuns: RUNS }
      )
    })

    test('four value series and two span series fit together; a third span does not', () => {
      const params = new URLSearchParams()
      const valueIds = ['a', 'b', 'c', 'd'].map((code) =>
        observationSource.seriesIdOf({ kind: 'points', system: null, code, unit: null })
      )
      const spanIds = ['x', 'y', 'z'].map((code) =>
        observationSource.seriesIdOf({ kind: 'spans', system: null, code })
      )
      for (const id of [...valueIds, ...spanIds]) params.append(SERIES_PARAM, id)
      expect(decodeSelection(params).series).toEqual([...valueIds, ...spanIds.slice(0, 2)])
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

describe('selectionCapsOf / capIsFull', () => {
  test('counts each id against the cap its kind reads as, and junk against neither', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(seriesIdArb, { maxLength: ValueAxis.CAP + 2 }),
        fc.uniqueArray(spanSeriesIdArb, { maxLength: SpanSeries.LANE_CAP + 2 }),
        (valueIds, spanIds) => {
          const caps = selectionCapsOf([...valueIds, 'not a series id', ...spanIds])
          expect(caps).toEqual({ valueSeriesCount: valueIds.length, laneCount: spanIds.length })
          expect(capIsFull(caps, 'points')).toBe(valueIds.length >= ValueAxis.CAP)
          expect(capIsFull(caps, 'levels')).toBe(valueIds.length >= ValueAxis.CAP)
          expect(capIsFull(caps, 'spans')).toBe(spanIds.length >= SpanSeries.LANE_CAP)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('a decoded selection never fills past either cap', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(seriesIdArb, spanSeriesIdArb, fc.string())), (ids) => {
        const params = new URLSearchParams(ids.map((id) => [SERIES_PARAM, id]))
        const caps = selectionCapsOf(decodeSelection(params).series)
        expect(caps.valueSeriesCount).toBeLessThanOrEqual(ValueAxis.CAP)
        expect(caps.laneCount).toBeLessThanOrEqual(SpanSeries.LANE_CAP)
      }),
      { numRuns: RUNS }
    )
  })
})
