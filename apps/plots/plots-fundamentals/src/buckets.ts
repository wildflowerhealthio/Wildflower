import { DateTime } from 'effect'

import type * as PointSeries from './point-series.ts'
import type * as Series from './series.ts'
import * as TimeDomain from './time-domain.ts'

/**
 * The readings of a point series that fell in one fixed-width slice of the
 * time domain, summarised.
 *
 * - `start` / `end`: the slice, half-open — `start` included, `end` not.
 * - `time`: the slice's middle, where the bucket is drawn and the crosshair
 *   stops.
 * - `mean`, `min`, `max`: of the readings' values; `min` and `max` are
 *   readings themselves.
 * - `count`: how many readings fell in it, never `0`.
 */
interface Bucket {
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc
  readonly time: DateTime.Utc
  readonly mean: number
  readonly min: number
  readonly max: number
  readonly count: number
}

/** A bucket's running totals while the readings are read. */
interface Totals {
  sum: number
  min: number
  max: number
  count: number
}

/**
 * Split `xDomain` into `bucketCount` time slices of equal width and summarise
 * the readings of `points` that fall in each.
 *
 * @param points - In any order; those outside `xDomain` are ignored
 * @param bucketCount - A positive integer
 * @returns The buckets holding at least one reading, sorted by time — an empty
 *   slice is left out, so a stretch without readings stays a gap
 *
 * @throws When `bucketCount` is not a positive integer
 *
 * @remarks
 * The slices tile the domain's whole milliseconds `[start, end + 1)` and their
 * edges are whole milliseconds too, so every reading inside the domain lands
 * in exactly one, and {@link at} finds that one by the same edges. `mean` is
 * clamped into `[min, max]`: summing can round it a hair outside when every
 * reading is equal.
 */
const of = (
  points: readonly PointSeries.Point[],
  xDomain: TimeDomain.TimeDomain,
  bucketCount: number
): readonly Bucket[] => {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new RangeError(`A bucket count must be a positive integer, not ${bucketCount}`)
  }
  const domainStart = xDomain[0].epochMillis
  const span = xDomain[1].epochMillis - domainStart + 1
  const edge = (index: number): number => domainStart + Math.ceil((index * span) / bucketCount)
  const totals: (Totals | undefined)[] = Array.from({ length: bucketCount })
  for (const point of points) {
    if (!TimeDomain.contains(xDomain, point.time.epochMillis)) continue
    const index = indexOf(point.time.epochMillis - domainStart, span, bucketCount)
    const bucket = totals[index]
    if (bucket === undefined) {
      totals[index] = { sum: point.value, min: point.value, max: point.value, count: 1 }
    } else {
      bucket.sum += point.value
      bucket.min = Math.min(bucket.min, point.value)
      bucket.max = Math.max(bucket.max, point.value)
      bucket.count += 1
    }
  }
  return totals.flatMap((bucket, index) => {
    if (bucket === undefined) return []
    const start = edge(index)
    const end = edge(index + 1)
    return [
      {
        start: DateTime.unsafeMake(start),
        end: DateTime.unsafeMake(end),
        time: DateTime.unsafeMake(Math.floor((start + end) / 2)),
        mean: Math.min(bucket.max, Math.max(bucket.min, bucket.sum / bucket.count)),
        min: bucket.min,
        max: bucket.max,
        count: bucket.count,
      },
    ]
  })
}

/**
 * The slice `offset` milliseconds into a domain `span` milliseconds wide
 * falls in: the `index` with `index * span <= offset * bucketCount < (index + 1) * span`,
 * the same inequality the slice edges in {@link of} round up from.
 *
 * @remarks
 * Exact for any domain a chart spans: both operands are whole numbers well
 * under 2^52, so the quotient cannot round onto the next integer.
 */
const indexOf = (offset: number, span: number, bucketCount: number): number =>
  Math.floor((offset * bucketCount) / span)

/**
 * The bucket whose slice holds `time`, the one a crosshair there reads.
 *
 * @param buckets - Sorted by time, as {@link of} returns them
 * @returns `null` when `time` falls in a left-out slice or outside them all
 *
 * @remarks
 * No fallback to a neighbour: a gap in the readings reads as a gap. Binary
 * search, since this runs on every pointer move.
 */
const at = (buckets: readonly Bucket[], time: DateTime.Utc): Bucket | null => {
  const target = time.epochMillis
  let low = 0
  let high = buckets.length - 1
  let found: Bucket | null = null
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (buckets[middle].start.epochMillis <= target) {
      found = buckets[middle]
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found !== null && target < found.end.epochMillis ? found : null
}

/**
 * Bucket each point series in `plotted` with more readings inside `xDomain`
 * than `bucketCount` — too many to draw one by one.
 *
 * @returns Each such series' buckets ({@link of}), keyed by series id; a level
 *   series, and a point series with no more readings than buckets, is absent
 *   and drawn as it is
 *
 * @remarks
 * The one decision of which series are drawn as buckets: the chart's marks,
 * `Crosshair.stops` and the readout all read this map, so they never disagree.
 */
const ofDenseSeries = (
  plotted: readonly Series.Series[],
  xDomain: TimeDomain.TimeDomain,
  bucketCount: number
): ReadonlyMap<string, readonly Bucket[]> =>
  new Map(
    plotted.flatMap((series) =>
      series.kind === 'points' &&
      TimeDomain.pointsWithin(series.points, xDomain).length > bucketCount
        ? [[series.id, of(series.points, xDomain, bucketCount)] as const]
        : []
    )
  )

export { at, of, ofDenseSeries }
export type { Bucket }
