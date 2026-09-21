import { DateTime } from 'effect'

/** The time windows the viewer offers along the x axis. */
type RangePreset = 'all' | '5y' | '1y' | '90d'

/** Every {@link RangePreset}, in the order a picker lists them. */
const RANGE_PRESETS: readonly RangePreset[] = ['all', '5y', '1y', '90d']

/** Whether `value` names a {@link RangePreset} — the guard the URL codec decodes through. */
const isRangePreset = (value: string): value is RangePreset =>
  (RANGE_PRESETS as readonly string[]).includes(value)

/**
 * How far back each bounded preset reaches from `now`. The year presets
 * subtract calendar years, not fixed spans, so they are not invertible across
 * a leap day.
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
 * @param dataExtent - What the plotted data spans, or `null` when nothing is
 * @returns The window to draw
 *
 * @remarks
 * `'all'` is the data's own extent. With no data it falls back to the last
 * year ending at `now`, so the axis draws empty rather than collapsing to a
 * single instant.
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

/** The points inside `domain`, endpoints included, in input order. */
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
