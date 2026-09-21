import type { DateTime } from 'effect'

import {
  type DoseSegment,
  type MedicationSeries,
  type ObservationSeries,
  type Series,
  type SeriesPoint,
  isObservationSeries,
} from './series.ts'

/** What a series shows at a crosshair instant. */
type ValueAt =
  | {
      readonly kind: 'observation'
      readonly series: ObservationSeries
      readonly point: SeriesPoint
    }
  | {
      readonly kind: 'medication'
      readonly series: MedicationSeries
      readonly segment: DoseSegment
    }

/**
 * The point a crosshair reads off an observation series.
 *
 * @param points - Sorted ascending by `time`, as {@link ObservationSeries} guarantees
 * @returns The last point at or before `time`, the first point after it when
 *   the crosshair sits before the series starts, or `null` when empty
 *
 * @remarks
 * Binary search: this runs on every pointer move over a series that can hold
 * thousands of points.
 */
const pointAt = (points: readonly SeriesPoint[], time: DateTime.Utc): SeriesPoint | null => {
  if (points.length === 0) return null
  const target = time.epochMillis
  let low = 0
  let high = points.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (points[middle].time.epochMillis <= target) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found === -1 ? points[0] : points[found]
}

/**
 * The dose segment in effect at `time`.
 *
 * @param segments - Sorted ascending by `start`, as {@link MedicationSeries} guarantees
 * @returns The latest-starting segment that has begun and not ended, or `null`
 *
 * @remarks
 * No fallback, unlike {@link pointAt}: outside every segment the patient was
 * not on the medication, which is a real answer rather than a nearest dose.
 */
const segmentAt = (segments: readonly DoseSegment[], time: DateTime.Utc): DoseSegment | null => {
  const target = time.epochMillis
  let inEffect: DoseSegment | null = null
  for (const segment of segments) {
    if (segment.start.epochMillis > target) break
    if (segment.end === null || segment.end.epochMillis >= target) inEffect = segment
  }
  return inEffect
}

/**
 * What the crosshair reads off `series` at `time`.
 *
 * @returns `null` when the series has nothing to show there
 */
const valueAt = (series: Series, time: DateTime.Utc): ValueAt | null => {
  if (isObservationSeries(series)) {
    const point = pointAt(series.points, time)
    return point === null ? null : { kind: 'observation', series, point }
  }
  const segment = segmentAt(series.segments, time)
  return segment === null ? null : { kind: 'medication', series, segment }
}

export type { ValueAt }
export { pointAt, segmentAt, valueAt }
