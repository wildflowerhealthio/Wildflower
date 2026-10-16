import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { smallMillis, spanFrom, spanSeriesArb, spanSeriesOf } from './arbitraries.test-helpers.ts'
import * as SpanSeries from './span-series.ts'

const RUNS = numRunsFor({ base: 200 })

describe('SpanSeries.spansAt', () => {
  test('is the spans covering the instant, a hand-off going to the starting span', () => {
    fc.assert(
      fc.property(spanSeriesArb, smallMillis, (series, millis) => {
        const found = SpanSeries.spansAt(series, DateTime.unsafeMake(millis))
        const covering = series.spans.filter(
          (span) => span.start.epochMillis <= millis && millis <= span.end.epochMillis
        )
        const handedOff = covering.some((span) => span.start.epochMillis === millis)
        expect(found).toEqual(
          handedOff
            ? covering.filter(
                (span) => span.start.epochMillis === millis || span.end.epochMillis !== millis
              )
            : covering
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('at a hand-off reads only the span starting there', () => {
    const asleep = { id: 'asleep', label: 'Asleep', colourSlot: 0 }
    const walking = { id: 'walking', label: 'Walking', colourSlot: 1 }
    const series = spanSeriesOf([spanFrom(0, 100, asleep), spanFrom(100, 160, walking)])
    expect(
      SpanSeries.spansAt(series, DateTime.unsafeMake(100)).map((span) => span.category.id)
    ).toEqual(['walking'])
  })

  test('still reads a span at its end when nothing starts there', () => {
    const asleep = { id: 'asleep', label: 'Asleep', colourSlot: 0 }
    const series = spanSeriesOf([spanFrom(0, 100, asleep)])
    expect(
      SpanSeries.spansAt(series, DateTime.unsafeMake(100)).map((span) => span.category.id)
    ).toEqual(['asleep'])
  })

  test('lists both of two overlapping spans, and nothing in a gap', () => {
    const asleep = { id: 'asleep', label: 'Asleep', colourSlot: 0 }
    const deep = { id: 'deep', label: 'Deep', colourSlot: 1 }
    const series = spanSeriesOf([spanFrom(0, 100, asleep), spanFrom(20, 40, deep)])
    expect(
      SpanSeries.spansAt(series, DateTime.unsafeMake(30)).map((span) => span.category.id)
    ).toEqual(['asleep', 'deep'])
    expect(SpanSeries.spansAt(series, DateTime.unsafeMake(150))).toEqual([])
  })
})

describe('SpanSeries.categoriesOf', () => {
  test('lists each category once, by colour slot, the neutral ones last', () => {
    fc.assert(
      fc.property(spanSeriesArb, (series) => {
        const categories = SpanSeries.categoriesOf(series)
        const ids = categories.map((category) => category.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(new Set(ids)).toEqual(new Set(series.spans.map((span) => span.category.id)))
        const slots = categories.map((category) => category.colourSlot ?? SpanSeries.COLOUR_SLOTS)
        expect(slots).toEqual(slots.toSorted((left, right) => left - right))
      }),
      { numRuns: RUNS }
    )
  })
})
