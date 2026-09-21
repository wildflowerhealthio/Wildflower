import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import type { DoseSegment, MedicationSeries, ObservationSeries, SeriesPoint } from './series.ts'
import { pointAt, segmentAt, valueAt } from './values-at.ts'

const RUNS = numRunsFor({ base: 200 })

const instant = fc.integer({ min: 0, max: 1_000_000 }).map((millis) => DateTime.unsafeMake(millis))

const sortedPoints = fc
  .array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 30 })
  .map((millis): readonly SeriesPoint[] =>
    millis
      .toSorted((left, right) => left - right)
      .map((value) => ({ time: DateTime.unsafeMake(value), value }))
  )

/**
 * The obvious, slow reading of the same rule, for the binary search to be
 * checked against. Deliberately written as a scan so a bug in the search
 * cannot hide in a shared helper.
 */
const pointAtByScan = (points: readonly SeriesPoint[], time: DateTime.Utc): SeriesPoint | null => {
  if (points.length === 0) return null
  const before = points.filter((point) => point.time.epochMillis <= time.epochMillis)
  return before.length === 0 ? points[0] : before[before.length - 1]
}

const segment = (start: number, end: number | null, dose: number): DoseSegment => ({
  start: DateTime.unsafeMake(start),
  end: end === null ? null : DateTime.unsafeMake(end),
  dose,
  perDay: true,
  status: 'active',
  dashed: false,
  requestId: `req-${start}`,
})

const observationSeries = (points: readonly SeriesPoint[]): ObservationSeries => ({
  key: { kind: 'observation', system: null, code: 'code', unit: null },
  label: 'Label',
  unit: null,
  category: null,
  points,
  kind: 'quantity',
})

const medicationSeries = (segments: readonly DoseSegment[]): MedicationSeries => ({
  key: { kind: 'medication', name: 'insulin', unit: 'mg' },
  label: 'Insulin',
  unit: 'mg',
  segments: segments.toSorted((left, right) => left.start.epochMillis - right.start.epochMillis),
})

describe('pointAt', () => {
  test('agrees with a linear scan of the same rule, always', () => {
    fc.assert(
      fc.property(sortedPoints, instant, (points, time) => {
        expect(pointAt(points, time)).toEqual(pointAtByScan(points, time))
      }),
      { numRuns: RUNS }
    )
  })

  test('returns the last point at or before the crosshair when one exists', () => {
    fc.assert(
      fc.property(sortedPoints, instant, (points, time) => {
        const found = pointAt(points, time)
        if (found === null) return
        if (found.time.epochMillis <= time.epochMillis) {
          const later = points.filter(
            (point) =>
              point.time.epochMillis > found.time.epochMillis &&
              point.time.epochMillis <= time.epochMillis
          )
          expect(later).toEqual([])
        } else {
          // Only the "nothing before" fallback may return a later point, and
          // then it must be the very first.
          expect(found).toBe(points[0])
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a crosshair landing exactly on a point reads that point, not the one before', () => {
    fc.assert(
      fc.property(
        sortedPoints
          .filter((points) => points.length > 0)
          .chain((points) =>
            fc.tuple(fc.constant(points), fc.integer({ min: 0, max: points.length - 1 }))
          ),
        ([points, index]) => {
          const target = points[index]
          const found = pointAt(points, target.time)
          expect(found?.time.epochMillis).toBe(target.time.epochMillis)
          // Ties keep the last point at that instant, matching the scan.
          expect(found).toEqual(pointAtByScan(points, target.time))
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('a crosshair before the data still names the first reading', () => {
    const points = [
      { time: DateTime.unsafeMake(100), value: 1 },
      { time: DateTime.unsafeMake(200), value: 2 },
    ]
    expect(pointAt(points, DateTime.unsafeMake(0))).toBe(points[0])
  })

  test('an empty series reads nothing', () => {
    expect(pointAt([], DateTime.unsafeMake(0))).toBeNull()
  })
})

describe('segmentAt', () => {
  test('the result, when there is one, actually covers the instant', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }))
            .map(([start, length]) => segment(start, start + length, 1)),
          { maxLength: 8 }
        ),
        instant.map((time) => DateTime.unsafeMake(time.epochMillis % 2000)),
        (segments, time) => {
          const sorted = medicationSeries(segments).segments
          const found = segmentAt(sorted, time)
          if (found === null) {
            for (const candidate of sorted) {
              const covers =
                candidate.start.epochMillis <= time.epochMillis &&
                (candidate.end === null || candidate.end.epochMillis >= time.epochMillis)
              expect(covers).toBe(false)
            }
          } else {
            expect(found.start.epochMillis).toBeLessThanOrEqual(time.epochMillis)
            expect(found.end === null || found.end.epochMillis >= time.epochMillis).toBe(true)
          }
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('overlapping segments resolve to the latest one that has started', () => {
    const segments = medicationSeries([segment(0, 100, 5), segment(50, 100, 10)]).segments
    expect(segmentAt(segments, DateTime.unsafeMake(75))?.dose).toBe(10)
  })

  test('an open-ended segment stays in effect indefinitely', () => {
    const segments = medicationSeries([segment(0, null, 5)]).segments
    expect(segmentAt(segments, DateTime.unsafeMake(999_999))?.dose).toBe(5)
  })

  test('a gap between segments reads as nothing in effect, not as the nearest dose', () => {
    const segments = medicationSeries([segment(0, 10, 5), segment(100, 110, 7)]).segments
    expect(segmentAt(segments, DateTime.unsafeMake(50))).toBeNull()
  })
})

describe('valueAt', () => {
  test('an observation series reads through pointAt', () => {
    fc.assert(
      fc.property(sortedPoints, instant, (points, time) => {
        const read = valueAt(observationSeries(points), time)
        const expected = pointAt(points, time)
        if (expected === null) expect(read).toBeNull()
        else
          expect(read).toEqual({
            kind: 'observation',
            series: observationSeries(points),
            point: expected,
          })
      }),
      { numRuns: RUNS }
    )
  })

  test('a medication series reads through segmentAt', () => {
    const series = medicationSeries([segment(0, 100, 5)])
    expect(valueAt(series, DateTime.unsafeMake(50))).toEqual({
      kind: 'medication',
      series,
      segment: series.segments[0],
    })
    expect(valueAt(series, DateTime.unsafeMake(500))).toBeNull()
  })
})
