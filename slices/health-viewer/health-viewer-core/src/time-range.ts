import { DateTime } from 'effect'

/** The time windows the viewer offers along the x axis. */
type RangePreset = 'all' | '5y' | '1y' | '90d'

/** Every {@link RangePreset}, in the order a picker lists them. */
const RANGE_PRESETS: readonly RangePreset[] = ['all', '5y', '1y', '90d']

/** Whether `value` names a {@link RangePreset} — the guard the URL codec decodes through. */
const isRangePreset = (value: string): value is RangePreset =>
  (RANGE_PRESETS as readonly string[]).includes(value)

/**
 * How far back each bounded preset reaches from `now`.
 *
 * @remarks
 * The year-length presets subtract calendar years, not fixed spans, so "1y"
 * lands on the same date a year earlier regardless of leap days.
 */
const PRESET_LOOKBACK: Readonly<
  Record<Exclude<RangePreset, 'all'>, Partial<DateTime.DateTime.PartsForMath>>
> = {
  '5y': { years: 5 },
  '1y': { years: 1 },
  '90d': { days: 90 },
}

/** A closed time interval, `[start, end]`, with `start <= end`. */
type TimeDomain = readonly [DateTime.Utc, DateTime.Utc]

/**
 * The x-axis window a preset selects.
 *
 * @param preset - The chosen window
 * @param now - The instant a bounded preset ends at
 * @param dataExtent - The `[first, last]` instants the plotted data spans, or
 *   `null` when nothing is plotted
 * @returns The window to draw
 *
 * @remarks
 * `'all'` is the data's own extent, so the chart fills its width with what
 * there is. With no data at all it falls back to the last year ending at
 * `now`, which gives the axis a sane scale to draw empty rather than
 * collapsing to a single instant.
 */
const xDomain = (
  preset: RangePreset,
  now: DateTime.Utc,
  dataExtent: TimeDomain | null
): TimeDomain => {
  if (preset === 'all') {
    return dataExtent ?? [DateTime.subtract(now, PRESET_LOOKBACK['1y']), now]
  }
  return [DateTime.subtract(now, PRESET_LOOKBACK[preset]), now]
}

/**
 * The points of `points` that fall inside `domain`, endpoints included.
 *
 * @typeParam A - Any dated value; only its `time` is read
 * @returns The matching points, in input order
 */
const pointsWithin = <A extends { readonly time: DateTime.Utc }>(
  points: readonly A[],
  domain: TimeDomain
): readonly A[] => {
  const [start, end] = domain
  return points.filter(
    (point) =>
      point.time.epochMillis >= start.epochMillis && point.time.epochMillis <= end.epochMillis
  )
}

export type { RangePreset, TimeDomain }
export { PRESET_LOOKBACK, RANGE_PRESETS, isRangePreset, pointsWithin, xDomain }
