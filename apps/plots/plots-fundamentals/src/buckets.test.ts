import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  levelSeriesArb,
  pointArb,
  pointSeriesArb,
  pointSeriesOf,
  smallMillis,
  windowArb,
} from './arbitraries.test-helpers.ts'
import * as Buckets from './buckets.ts'
import type * as PointSeries from './point-series.ts'
import * as TimeDomain from './time-domain.ts'

const RUNS = numRunsFor({ base: 200 })

const bucketCountArb = fc.integer({ min: 1, max: 50 })
const pointsArb = fc.array(pointArb, { maxLength: 40 })

/** Whether `bucket`'s half-open slice holds the instant `millis`. */
const holds = (bucket: Buckets.Bucket, millis: number): boolean =>
  bucket.start.epochMillis <= millis && millis < bucket.end.epochMillis

const inDomain = (
  points: readonly PointSeries.Point[],
  xDomain: TimeDomain.TimeDomain
): readonly PointSeries.Point[] => TimeDomain.pointsWithin(points, xDomain)

describe('Buckets.of', () => {
  test('every reading inside the domain lands in exactly one bucket, the one at finds', () => {
    fc.assert(
      fc.property(pointsArb, windowArb, bucketCountArb, (points, xDomain, bucketCount) => {
        const buckets = Buckets.of(points, xDomain, bucketCount)
        for (const point of inDomain(points, xDomain)) {
          const holding = buckets.filter((bucket) => holds(bucket, point.time.epochMillis))
          expect(holding).toHaveLength(1)
          expect(Buckets.at(buckets, point.time)).toBe(holding[0])
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('counts sum to the readings inside the domain, and each summarises its own readings', () => {
    fc.assert(
      fc.property(pointsArb, windowArb, bucketCountArb, (points, xDomain, bucketCount) => {
        const kept = inDomain(points, xDomain)
        const buckets = Buckets.of(points, xDomain, bucketCount)
        expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(kept.length)
        for (const bucket of buckets) {
          const values = kept
            .filter((point) => holds(bucket, point.time.epochMillis))
            .map((point) => point.value)
          expect(bucket.count).toBe(values.length)
          expect(bucket.min).toBe(Math.min(...values))
          expect(bucket.max).toBe(Math.max(...values))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('min ≤ mean ≤ max', () => {
    fc.assert(
      fc.property(pointsArb, windowArb, bucketCountArb, (points, xDomain, bucketCount) => {
        for (const bucket of Buckets.of(points, xDomain, bucketCount)) {
          expect(bucket.min).toBeLessThanOrEqual(bucket.mean)
          expect(bucket.mean).toBeLessThanOrEqual(bucket.max)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('buckets are sorted, never overlap, and lie inside the domain with their middle inside them', () => {
    fc.assert(
      fc.property(pointsArb, windowArb, bucketCountArb, (points, xDomain, bucketCount) => {
        const buckets = Buckets.of(points, xDomain, bucketCount)
        expect(buckets.length).toBeLessThanOrEqual(bucketCount)
        buckets.forEach((bucket, index) => {
          expect(bucket.count).toBeGreaterThan(0)
          expect(holds(bucket, bucket.time.epochMillis)).toBe(true)
          expect(TimeDomain.contains(xDomain, bucket.start.epochMillis)).toBe(true)
          expect(TimeDomain.contains(xDomain, bucket.end.epochMillis - 1)).toBe(true)
          const next = buckets[index + 1]
          if (next !== undefined) {
            expect(bucket.end.epochMillis).toBeLessThanOrEqual(next.start.epochMillis)
          }
        })
      }),
      { numRuns: RUNS }
    )
  })

  test('an empty series has no buckets', () => {
    expect(Buckets.of([], [DateTime.unsafeMake(0), DateTime.unsafeMake(100)], 10)).toEqual([])
  })

  test('a single reading is one bucket summarising just it', () => {
    const [bucket, ...rest] = Buckets.of(
      [{ time: DateTime.unsafeMake(42), value: 7.5 }],
      [DateTime.unsafeMake(0), DateTime.unsafeMake(99)],
      10
    )
    expect(rest).toEqual([])
    expect(bucket).toMatchObject({ mean: 7.5, min: 7.5, max: 7.5, count: 1 })
    expect([bucket.start.epochMillis, bucket.end.epochMillis]).toEqual([40, 50])
    expect(bucket.time.epochMillis).toBe(45)
  })

  test('a reading on the domain end lands in the last slice, and readings outside are ignored', () => {
    const xDomain: TimeDomain.TimeDomain = [DateTime.unsafeMake(0), DateTime.unsafeMake(99)]
    const buckets = Buckets.of(
      [
        { time: DateTime.unsafeMake(-1), value: 1 },
        { time: DateTime.unsafeMake(99), value: 2 },
        { time: DateTime.unsafeMake(100), value: 3 },
      ],
      xDomain,
      10
    )
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ mean: 2, count: 1 })
    expect([buckets[0].start.epochMillis, buckets[0].end.epochMillis]).toEqual([90, 100])
  })

  test('a single-instant domain is one bucket at that instant', () => {
    const instant = DateTime.unsafeMake(500)
    const buckets = Buckets.of(
      [
        { time: instant, value: 1 },
        { time: instant, value: 3 },
      ],
      [instant, instant],
      8
    )
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ mean: 2, min: 1, max: 3, count: 2 })
    expect(buckets[0].time.epochMillis).toBe(500)
  })

  test('refuses a bucket count that is not a positive integer', () => {
    const xDomain: TimeDomain.TimeDomain = [DateTime.unsafeMake(0), DateTime.unsafeMake(99)]
    expect(() => Buckets.of([], xDomain, 0)).toThrow(RangeError)
    expect(() => Buckets.of([], xDomain, 2.5)).toThrow(RangeError)
  })
})

describe('Buckets.at', () => {
  test('is the bucket holding the time, by a scan, or null in a gap', () => {
    fc.assert(
      fc.property(
        pointsArb,
        windowArb,
        bucketCountArb,
        smallMillis,
        (points, xDomain, bucketCount, millis) => {
          const buckets = Buckets.of(points, xDomain, bucketCount)
          expect(Buckets.at(buckets, DateTime.unsafeMake(millis))).toBe(
            buckets.find((bucket) => holds(bucket, millis)) ?? null
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('reads nothing from no buckets', () => {
    expect(Buckets.at([], DateTime.unsafeMake(0))).toBeNull()
  })
})

describe('Buckets.ofDenseSeries', () => {
  test('buckets exactly the point series with more readings in the domain than buckets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(pointSeriesArb, levelSeriesArb), { maxLength: 4 }),
        windowArb,
        fc.integer({ min: 1, max: 10 }),
        (drafts, xDomain, bucketCount) => {
          const plotted = drafts.map((series, index) => ({ ...series, id: `s${index}` }))
          const bucketsBySeriesId = Buckets.ofDenseSeries(plotted, xDomain, bucketCount)
          for (const series of plotted) {
            const dense =
              series.kind === 'points' && inDomain(series.points, xDomain).length > bucketCount
            expect(bucketsBySeriesId.get(series.id)).toEqual(
              dense ? Buckets.of(series.points, xDomain, bucketCount) : undefined
            )
          }
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('a series with as many readings as buckets is drawn as it is', () => {
    const series = pointSeriesOf([
      { time: DateTime.unsafeMake(0), value: 1 },
      { time: DateTime.unsafeMake(50), value: 2 },
    ])
    const xDomain: TimeDomain.TimeDomain = [DateTime.unsafeMake(0), DateTime.unsafeMake(99)]
    expect(Buckets.ofDenseSeries([series], xDomain, 2).has(series.id)).toBe(false)
    expect(Buckets.ofDenseSeries([series], xDomain, 1).has(series.id)).toBe(true)
  })
})
