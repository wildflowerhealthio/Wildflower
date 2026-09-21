import { type Series, isObservationSeries } from './series.ts'

/**
 * How many series the chart plots at once.
 *
 * @remarks
 * A rendering limit: each series needs its own value axis, and two per side is
 * as many as fit without the gutters swallowing the plot. {@link assignAxes}
 * throws past it rather than dropping one silently, so a selection UI caps
 * against this constant.
 */
const AXIS_CAP = 4

/** A closed numeric interval, `[low, high]`, with `low <= high`. */
type Domain = readonly [number, number]

/** One series' value axis: which side it hangs on, and the scale it draws. */
interface AxisSlot {
  readonly series: Series
  readonly side: 'left' | 'right'
  /** Position among the axes on this same `side`, `0` being the one nearest the plot. */
  readonly index: number
  readonly domain: Domain
  /** Round values inside `domain` to label, ascending. */
  readonly ticks: readonly number[]
}

/** Step multipliers that keep tick labels readable in any unit. */
const NICE_MULTIPLIERS: readonly number[] = [1, 2, 5, 10]

/** A "nice" step at or above `rough` — 1, 2 or 5 times a power of ten. */
const niceStep = (rough: number): number => {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  // A subnormal `rough` floors its exponent past the smallest representable
  // power of ten, underflowing `magnitude` to zero and poisoning everything
  // downstream with `Infinity`/`NaN`. The unrounded step is exact enough there.
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return rough
  const nice = NICE_MULTIPLIERS.find((multiplier) => rough / magnitude <= multiplier) ?? 10
  const step = nice * magnitude
  return step > 0 && Number.isFinite(step) ? step : rough
}

/** Fraction of an extent added at each end before rounding, so points clear the axis ends. */
const PADDING_FRACTION = 0.05

/**
 * Round `[low, high]` outward onto tick-sized boundaries, after padding.
 *
 * @returns A domain that contains `[low, high]` — guaranteed, not merely
 *   intended, by the re-widening in {@link roundOutward}
 *
 * @remarks
 * A degenerate input (every value identical) is opened up around the value
 * first rather than collapsing the axis to a point.
 */
const niceDomain = (low: number, high: number, count: number): Domain => {
  if (!(high > low)) {
    const halved = Math.abs(low) / 2
    const half = halved > 0 && Number.isFinite(halved) ? halved : 1
    return roundOutward(low - half, low + half, count, low, low)
  }
  return roundOutward(low, high, count, low, high)
}

/**
 * Pad, round outward to a tick-sized step, then re-widen to contain
 * `[containLow, containHigh]`.
 *
 * @remarks
 * That last widening is load-bearing: `Math.floor(x / step) * step` is
 * mathematically at or below `x`, but the two float operations can round the
 * product back above it, leaving a value outside its own axis.
 */
const roundOutward = (
  low: number,
  high: number,
  count: number,
  containLow: number,
  containHigh: number
): Domain => {
  const padding = (high - low) * PADDING_FRACTION
  const paddedLow = low - padding
  const paddedHigh = high + padding
  const step = niceStep((paddedHigh - paddedLow) / count)
  const roundedLow = Math.floor(paddedLow / step) * step
  const roundedHigh = Math.ceil(paddedHigh / step) * step
  if (!Number.isFinite(roundedLow) || !Number.isFinite(roundedHigh)) {
    return [containLow, containHigh]
  }
  return [Math.min(roundedLow, containLow), Math.max(roundedHigh, containHigh)]
}

/** Ceiling on generated ticks, so a pathological domain degenerates instead of allocating. */
const MAX_TICKS = 64

/** Default number of tick intervals an axis is rounded and labelled to. */
const DEFAULT_TICK_COUNT = 5

/**
 * The round values to label `domain` with.
 *
 * @returns Ascending ticks inside `domain`, always at least its two bounds
 */
const ticksFor = (domain: Domain, count: number = DEFAULT_TICK_COUNT): readonly number[] => {
  const [low, high] = domain
  if (!(high > low)) return [low]
  const step = niceStep((high - low) / count)
  // Indexed off the step rather than accumulated, so a fractional step (`0.1`)
  // cannot drift a later tick off its round value.
  const first = Math.ceil(low / step)
  const last = Math.floor(high / step)
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > MAX_TICKS) {
    return [low, high]
  }
  const ticks: number[] = []
  for (let index = first; index <= last; index += 1) ticks.push(index * step)
  return ticks.length >= 2 ? ticks : [low, high]
}

/** Where `value` sits in `domain`, as a fraction — `0` at the low end, `1` at the high. */
const normalise = (value: number, domain: Domain): number => {
  const [low, high] = domain
  return high === low ? 0 : (value - low) / (high - low)
}

/** The inverse of {@link normalise}: the value a fraction of `domain` stands for. */
const denormalise = (fraction: number, domain: Domain): number => {
  const [low, high] = domain
  return low + fraction * (high - low)
}

/**
 * The domain a series' own values — and its reference ranges — need.
 *
 * @remarks
 * Range bounds join the extent so a point inside its normal range still shows
 * the band around it. A dose axis starts at zero because a dose is a
 * non-negative magnitude and a zoomed-in baseline would overstate a change.
 * Nothing to plot yields `[0, 1]`, so the axis draws empty rather than not at
 * all.
 */
const domainFor = (series: Series): Domain => {
  if (!isObservationSeries(series)) {
    const doses = series.segments.map((segment) => segment.dose)
    const top = doses.length === 0 ? 0 : Math.max(...doses)
    return top <= 0 ? [0, 1] : [0, niceDomain(0, top, DEFAULT_TICK_COUNT)[1]]
  }
  if (series.kind === 'boolean') return [0, 1]
  const values = series.points.flatMap((point) => [
    point.value,
    ...(point.low === undefined ? [] : [point.low]),
    ...(point.high === undefined ? [] : [point.high]),
  ])
  if (values.length === 0) return [0, 1]
  return niceDomain(Math.min(...values), Math.max(...values), DEFAULT_TICK_COUNT)
}

/**
 * Give each selected series its own value axis.
 *
 * @param selected - The series to plot, in selection order
 * @returns One slot per input, in the same order
 * @throws When `selected` holds more than {@link AXIS_CAP} series
 *
 * @remarks
 * Sides alternate in selection order, so the two most recently added series
 * never crowd the same gutter and a series keeps its side as long as nothing
 * before it is removed.
 */
const assignAxes = (selected: readonly Series[]): readonly AxisSlot[] => {
  if (selected.length > AXIS_CAP) {
    throw new Error(
      `The health viewer plots at most ${AXIS_CAP} series at once; got ${selected.length}`
    )
  }
  return selected.map((series, position): AxisSlot => {
    const domain = domainFor(series)
    return {
      series,
      side: position % 2 === 0 ? 'left' : 'right',
      index: Math.floor(position / 2),
      domain,
      ticks: ticksFor(domain),
    }
  })
}

export type { AxisSlot, Domain }
export { AXIS_CAP, assignAxes, denormalise, domainFor, niceDomain, normalise, ticksFor }
