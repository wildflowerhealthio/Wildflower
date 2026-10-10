import { DateTime } from 'effect'
import * as fc from 'fast-check'

import {
  type LevelSeries,
  type PointSeries,
  type Series,
  type TimeDomain,
  ValueAxis,
} from '@wildflowerhealthio/health-viewer-fundamentals'

const DAY = 86_400_000
const WINDOW_START = Date.UTC(2024, 0, 1)

/** How many days the chart tests' window spans. */
const WINDOW_DAYS = 365

/** The chart tests' x domain: one year from 2024-01-01. */
const testWindow: TimeDomain.TimeDomain = [
  DateTime.unsafeMake(WINDOW_START),
  DateTime.unsafeMake(WINDOW_START + WINDOW_DAYS * DAY),
]

/** The instant `day` days into {@link testWindow}. */
const atDay = (day: number): DateTime.Utc => DateTime.unsafeMake(WINDOW_START + day * DAY)

/** Values on a two-decimal grid, a precision any source's values fit. */
const valueArb = fc.integer({ min: -100_000, max: 100_000 }).map((cents) => cents / 100)

/**
 * A point series of sorted, distinct days inside the window, some readings
 * carrying a band.
 */
const pointSeriesArb = (
  tag: string,
  interpolation: PointSeries.Interpolation = 'linear'
): fc.Arbitrary<PointSeries.PointSeries> =>
  fc
    .uniqueArray(
      fc.record({
        day: fc.integer({ min: 0, max: WINDOW_DAYS }),
        value: valueArb,
        band: fc.option(fc.tuple(valueArb, valueArb), { nil: null }),
      }),
      { minLength: 1, maxLength: 12, selector: (point) => point.day }
    )
    .map((points) => ({
      kind: 'points',
      id: `p:${tag}`,
      label: `Points ${tag}`,
      unit: 'u',
      valueScale: 'fitted',
      interpolation,
      points: points
        .toSorted((left, right) => left.day - right.day)
        .map(({ day, value, band }): PointSeries.Point =>
          band === null
            ? { time: atDay(day), value }
            : { time: atDay(day), value, low: Math.min(...band), high: Math.max(...band) }
        ),
    }))

/**
 * A level series of back-to-back or gapped levels in either line style, some
 * carrying a band or a note, the last possibly open.
 */
const levelSeriesArb = (tag: string): fc.Arbitrary<LevelSeries.LevelSeries> =>
  fc
    .record({
      levels: fc.array(
        fc.record({
          gap: fc.integer({ min: 0, max: 20 }),
          length: fc.integer({ min: 1, max: 60 }),
          value: fc.integer({ min: 1, max: 2000 }),
          lineStyle: fc.constantFrom<LevelSeries.LineStyle>('solid', 'dashed'),
          band: fc.option(fc.tuple(fc.nat(2000), fc.nat(2000)), { nil: null }),
          note: fc.option(fc.constantFrom('per day', 'per week'), { nil: null }),
        }),
        { minLength: 1, maxLength: 6 }
      ),
      openEnded: fc.boolean(),
    })
    .map(({ levels, openEnded }) => {
      let day = 0
      const built = levels.map((level, index): LevelSeries.StyledLevel => {
        const start = day + level.gap
        day = start + level.length
        return {
          start: atDay(start),
          end: openEnded && index === levels.length - 1 ? null : atDay(day),
          value: level.value,
          lineStyle: level.lineStyle,
          ...(level.band === null
            ? {}
            : { low: Math.min(...level.band), high: Math.max(...level.band) }),
          ...(level.note === null ? {} : { note: level.note }),
        }
      })
      return {
        kind: 'levels',
        id: `l:${tag}`,
        label: `Levels ${tag}`,
        unit: 'u',
        valueScale: 'from-zero',
        levels: built,
      }
    })

/** One to `ValueAxis.CAP` series with distinct ids, in selection order. */
const selectionArb = (
  seriesArb: (tag: string) => fc.Arbitrary<Series.Series>
): fc.Arbitrary<readonly Series.Series[]> =>
  fc
    .integer({ min: 1, max: ValueAxis.CAP })
    .chain((count) =>
      fc.tuple(...Array.from({ length: count }, (_, index) => seriesArb(`s${index}`)))
    )

export { WINDOW_DAYS, atDay, levelSeriesArb, pointSeriesArb, selectionArb, testWindow }
