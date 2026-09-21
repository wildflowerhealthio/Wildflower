import { type Series, isObservationSeries } from './series.ts'

/**
 * How many series the chart plots at once.
 *
 * @remarks
 * Four is a rendering limit, not a taste one: each series needs its own value
 * axis, and two axes per side is as many as fit beside a chart without the
 * gutters swallowing the plot area. {@link assignAxes} rejects a fifth rather
 * than dropping one silently, so a selection UI caps against this constant.
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

/**
 * A "nice" step at or above `rough` — 1, 2 or 5 times a power of ten.
 *
 * @remarks
 * The three multipliers are the ones that keep tick labels readable in any
 * unit: every tick lands on a value a reader can hold in their head.
 */
const NICE_MULTIPLIERS: readonly number[] = [1, 2, 5, 10]

const niceStep = (rough: number): number => {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  // A subnormal `rough` floors its exponent below the smallest representable
  // power of ten, so `magnitude` underflows to zero and every value derived
  // from it is `Infinity` or `NaN`. Fall back to the unrounded step, which is
  // exact enough at that scale and keeps the arithmetic downstream finite.
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return rough
  const fraction = rough / magnitude
  const nice = NICE_MULTIPLIERS.find((multiplier) => fraction <= multiplier) ?? 10
  const step = nice * magnitude
  return step > 0 && Number.isFinite(step) ? step : rough
}

/** Fraction of an extent added at each end before rounding, so points clear the axis ends. */
const PADDING_FRACTION = 0.05

/**
 * Round `[low, high]` outward onto tick-sized boundaries, after padding.
 *
 * @param count - Roughly how many tick intervals the domain should span
 * @returns A domain that contains `[low, high]` — guaranteed, not merely
 *   intended: the rounded bounds are re-widened against the inputs so
 *   floating-point rounding can never leave a value outside its own axis
 *
 * @remarks
 * A degenerate input (every value identical) has no extent to round, so it is
 * opened up around the value first — by half its magnitude, or to `[-1, 1]` at
 * zero — rather than collapsing the axis to a point.
 */
const niceDomain = (low: number, high: number, count: number): Domain => {
  if (!(high > low)) {
    // `Math.abs(low) / 2` underflows to zero for a denormal, which would leave
    // the interval just as degenerate, so fall back to a unit half-width.
    const halved = Math.abs(low) / 2
    const half = halved > 0 && Number.isFinite(halved) ? halved : 1
    return roundOutward(low - half, low + half, count, low, low)
  }
  return roundOutward(low, high, count, low, high)
}

/**
 * Pad `[low, high]`, round it outward to a tick-sized step, and re-widen the
 * result to contain `[containLow, containHigh]`.
 *
 * @remarks
 * The final widening is what makes {@link niceDomain}'s containment guarantee
 * hold: `Math.floor(x / step) * step` is mathematically at or below `x`, but
 * the two floating-point operations can round the product back above it.
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
  // Rounding at the edges of the float range can overflow to a non-finite
  // bound; an axis that cannot be drawn is worse than an unrounded one.
  if (!Number.isFinite(roundedLow) || !Number.isFinite(roundedHigh)) {
    return [containLow, containHigh]
  }
  return [Math.min(roundedLow, containLow), Math.max(roundedHigh, containHigh)]
}

/**
 * Ceiling on generated ticks, so a pathological domain degenerates to its two
 * bounds instead of allocating. A step derived from the domain puts a normal
 * axis well under this.
 */
const MAX_TICKS = 64

/** Default number of tick intervals an axis is rounded and labelled to. */
const DEFAULT_TICK_COUNT = 5

/**
 * The round values to label `domain` with.
 *
 * @param count - Roughly how many intervals to divide the domain into
 * @returns Ascending ticks inside `domain`, always at least its two bounds
 *
 * @remarks
 * Because {@link niceDomain} rounds to a step derived the same way, an axis
 * built by {@link assignAxes} normally gets ticks landing exactly on its ends.
 */
const ticksFor = (domain: Domain, count: number = DEFAULT_TICK_COUNT): readonly number[] => {
  const [low, high] = domain
  if (!(high > low)) return [low]
  const step = niceStep((high - low) / count)
  // Indexed off the step rather than accumulated, so a fractional step
  // (`0.1`) cannot drift a later tick off its round value.
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
 * The domain a series' own values (and reference ranges) need.
 *
 * @remarks
 * Reference-range bounds join the extent so a point sitting inside its normal
 * range still shows the band around it. A boolean series is pinned to
 * `[0, 1]`, and a medication's dose axis starts at zero — a dose is a
 * non-negative magnitude, and a zoomed-in baseline would overstate a change.
 * A series with nothing to plot gets `[0, 1]`, so the axis draws empty rather
 * than not at all.
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
 * @param selected - The series to plot, in selection order, at most
 *   {@link AXIS_CAP} of them
 * @returns One slot per input, in the same order
 * @throws When `selected` holds more than {@link AXIS_CAP} series
 *
 * @remarks
 * Sides alternate in selection order — first left, second right, third left —
 * so the two most recently added series never crowd the same gutter, and a
 * series keeps its side as long as nothing before it is removed.
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
