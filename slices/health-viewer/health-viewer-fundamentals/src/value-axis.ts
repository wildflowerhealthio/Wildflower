import type { Series } from './series.ts'

/**
 * How many series the chart plots at once, which is how many value axes it has.
 *
 * @remarks
 * A rendering limit: each series needs its own value axis, and two per side is
 * as many as fit without the gutters swallowing the plot. {@link assign}
 * throws past it rather than dropping one silently, so a selection UI caps
 * against this constant.
 */
const CAP = 4

/** A closed numeric interval, `[low, high]`, with `low <= high`. */
type Domain = readonly [number, number]

/** One series' value axis: which side it hangs on, and the scale it draws. */
interface ValueAxis {
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
  // `+ 0` turns the `-0` a zero tick gets from a negative `first` (`-0 * step`)
  // into `0`, so no formatter downstream prints a signed zero.
  for (let index = first; index <= last; index += 1) ticks.push(index * step + 0)
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

/** Every value and band bound `series` plots, which its axis must contain. */
const plottedValuesOf = (series: Series): readonly number[] =>
  (series.kind === 'points' ? series.points : series.levels).flatMap((mark) => [
    mark.value,
    ...(mark.low === undefined ? [] : [mark.low]),
    ...(mark.high === undefined ? [] : [mark.high]),
  ])

/**
 * The domain a series' own values — and its bands — need, fitted as its
 * `valueScale` says.
 *
 * @remarks
 * Band bounds join the extent so a value inside its normal range still shows
 * the band around it. A `'from-zero'` axis starts at zero whatever the values
 * are, and a `'zero-to-one'` axis is pinned. Nothing to plot yields `[0, 1]`,
 * so the axis draws empty rather than not at all.
 */
const domainFor = (series: Series): Domain => {
  if (series.valueScale === 'zero-to-one') return [0, 1]
  const values = plottedValuesOf(series)
  if (values.length === 0) return [0, 1]
  if (series.valueScale === 'from-zero') {
    const top = Math.max(...values)
    return top <= 0 ? [0, 1] : [0, niceDomain(0, top, DEFAULT_TICK_COUNT)[1]]
  }
  return niceDomain(Math.min(...values), Math.max(...values), DEFAULT_TICK_COUNT)
}

/**
 * Give each selected series its own value axis.
 *
 * @param selected - The series to plot, in selection order
 * @returns One slot per input, in the same order
 * @throws When `selected` holds more than {@link CAP} series
 *
 * @remarks
 * Sides alternate in selection order, so the two most recently added series
 * never crowd the same gutter and a series keeps its side as long as nothing
 * before it is removed.
 */
const assign = (selected: readonly Series[]): readonly ValueAxis[] => {
  if (selected.length > CAP) {
    throw new Error(`The health viewer plots at most ${CAP} series at once; got ${selected.length}`)
  }
  return selected.map((series, position): ValueAxis => {
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

export type { Domain, ValueAxis }
export { CAP, assign, denormalise, domainFor, niceDomain, normalise, ticksFor }
