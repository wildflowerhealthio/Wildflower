import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  levelSeriesArb,
  pointSeriesArb,
  seriesArb,
  smallMillis,
  windowArb,
} from './arbitraries.test-helpers.ts'
import * as Buckets from './buckets.ts'
import * as Crosshair from './crosshair.ts'
import * as Series from './series.ts'
import type * as TimeDomain from './time-domain.ts'

const RUNS = numRunsFor({ base: 200 })

const noBuckets: ReadonlyMap<string, readonly Buckets.Bucket[]> = new Map()

const inWindow = (window: TimeDomain.TimeDomain, millis: number): boolean =>
  millis >= window[0].epochMillis && millis <= window[1].epochMillis

const ascendingDistinct = (millis: readonly number[]): readonly number[] =>
  [...new Set(millis)].toSorted((left, right) => left - right)

describe('Crosshair.stops', () => {
  test('exactly the level boundaries inside the window, sorted and distinct', () => {
    fc.assert(
      fc.property(fc.array(seriesArb, { maxLength: 4 }), windowArb, (plotted, window) => {
        const boundaries = plotted.flatMap((series) =>
          Series.levelsOf(series).flatMap((level) => [
            level.start.epochMillis,
            ...(level.end === null ? [] : [level.end.epochMillis]),
          ])
        )
        expect(Crosshair.stops(plotted, window, noBuckets)).toEqual(
          ascendingDistinct(boundaries.filter((millis) => inWindow(window, millis)))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test("a point series' stops are exactly its reading times inside the window", () => {
    fc.assert(
      fc.property(pointSeriesArb, windowArb, (series, window) => {
        const readingTimes = series.points.map((point) => point.time.epochMillis)
        expect(Crosshair.stops([series], window, noBuckets)).toEqual(
          ascendingDistinct(readingTimes.filter((millis) => inWindow(window, millis)))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test("a level series' stops are its starts and stated ends inside the window", () => {
    fc.assert(
      fc.property(levelSeriesArb, windowArb, (series, window) => {
        const boundaries = series.levels.flatMap((level) =>
          level.end === null
            ? [level.start.epochMillis]
            : [level.start.epochMillis, level.end.epochMillis]
        )
        expect(Crosshair.stops([series], window, noBuckets)).toEqual(
          ascendingDistinct(boundaries.filter((millis) => inWindow(window, millis)))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test("a bucketed series' stops are exactly its bucket middles; the others' are unchanged", () => {
    fc.assert(
      fc.property(
        pointSeriesArb,
        levelSeriesArb,
        windowArb,
        fc.integer({ min: 1, max: 20 }),
        (bucketed, drawnAsIs, window, bucketCount) => {
          const buckets = Buckets.of(bucketed.points, window, bucketCount)
          const bucketsBySeriesId = new Map([[bucketed.id, buckets]])
          expect(Crosshair.stops([bucketed, drawnAsIs], window, bucketsBySeriesId)).toEqual(
            ascendingDistinct([
              ...buckets.map((bucket) => bucket.time.epochMillis),
              ...Crosshair.stops([drawnAsIs], window, noBuckets),
            ])
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('Crosshair.nearestStop', () => {
  test('returns the stop closest to the target, the earlier on a tie', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(smallMillis, { minLength: 1 }),
        fc.integer({ min: -10, max: 1_000_010 }),
        (unsorted, target) => {
          const sortedStops = unsorted.toSorted((left, right) => left - right)
          const bruteForce = sortedStops.reduce((best, stop) =>
            Math.abs(stop - target) < Math.abs(best - target) ? stop : best
          )
          expect(Crosshair.nearestStop(sortedStops, target)).toBe(bruteForce)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('falls back to the target when nothing is plotted', () => {
    fc.assert(
      fc.property(fc.integer(), (target) => {
        expect(Crosshair.nearestStop([], target)).toBe(target)
      }),
      { numRuns: RUNS }
    )
  })
})
