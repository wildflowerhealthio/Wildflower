import type * as Buckets from './buckets.ts'
import * as Series from './series.ts'
import * as TimeDomain from './time-domain.ts'

/**
 * Every instant the crosshair can rest on inside `window`: each level boundary
 * of each series — a start, and a stated end — or, for a series drawn as
 * buckets, each bucket's middle. Sorted, deduplicated, in epoch milliseconds.
 *
 * @param bucketsBySeriesId - The series drawn as buckets, from
 *   `Buckets.ofDenseSeries` — the same map the chart draws them from
 *
 * @remarks
 * Snapping to these rather than to the raw pointer time means the crosshair
 * always sits where some series changes, so the readout it lists
 * (`Series.levelAt`) is never a stale value picked between two changes. A
 * point series' levels begin at its readings and end at the next one, so its
 * stops are exactly its reading times; a bucketed series stops once per bucket,
 * where its readout (`Buckets.at`) names that bucket.
 */
const stops = (
  plotted: readonly Series.Series[],
  window: TimeDomain.TimeDomain,
  bucketsBySeriesId: ReadonlyMap<string, readonly Buckets.Bucket[]>
): readonly number[] => {
  const boundaries = plotted.flatMap((series) => {
    const buckets = bucketsBySeriesId.get(series.id)
    if (buckets !== undefined) return buckets.map((bucket) => bucket.time.epochMillis)
    return Series.levelsOf(series).flatMap((level) =>
      level.end === null
        ? [level.start.epochMillis]
        : [level.start.epochMillis, level.end.epochMillis]
    )
  })
  return [...new Set(boundaries)]
    .filter((boundary) => TimeDomain.contains(window, boundary))
    .toSorted((left, right) => left - right)
}

/**
 * The stop nearest `target`, the earlier one on a tie, or `target` itself when
 * there are none — the crosshair still reads every series there.
 *
 * @param sortedStops - Sorted ascending, as {@link stops} returns them
 *
 * @remarks
 * Binary search: this runs on every pointer move.
 */
const nearestStop = (sortedStops: readonly number[], target: number): number => {
  if (sortedStops.length === 0) return target
  let low = 0
  let high = sortedStops.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sortedStops[middle] < target) low = middle + 1
    else high = middle
  }
  const after = sortedStops[low]
  const before = low > 0 ? sortedStops[low - 1] : after
  return target - before <= after - target ? before : after
}

export { nearestStop, stops }
