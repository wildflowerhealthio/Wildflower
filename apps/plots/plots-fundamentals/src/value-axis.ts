import type { ValueScale, ValueSeries } from './series.ts'

/**
 * How many value series the chart plots at once, and so the most value axes
 * it can have. Span lanes take no value axis and count against
 * `SpanSeries.LANE_CAP` instead.
 *
 * @remarks
 * A rendering limit: series that share no axis each need their own, and two
 * per side is as many as fit without the gutters swallowing the plot.
 * {@link assign} throws past it rather than dropping one silently, so a
 * selection UI caps against this constant. It counts series, not axes, even
 * though series that share an axis leave gutters free.
 */
const CAP = 4

/** A closed numeric interval, `[low, high]`, with `low <= high`. */
type Domain = readonly [number, number]

/**
 * One value axis: the series drawn against it, which side it hangs on, and
 * the scale it draws.
 */
interface ValueAxis {
  /**
   * The series drawn against this axis, in selection order: one, or several
   * that {@link assign} found share a unit and a similar range.
   */
  readonly series: readonly [ValueSeries, ...ValueSeries[]]
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
 * How far a quotient may sit from a whole number, as a fraction of its size,
 * and still count as that whole number: a few units of float rounding error,
 * far below any real fraction of a step.
 */
const FLOAT_ROUNDING_TOLERANCE = 1e-14

/**
 * How many `step`s `value` lies from zero, signed: the whole count when the
 * division misses it only by float rounding, so a bound computed as a
 * multiple of `step` reads back as one; otherwise the fractional quotient.
 *
 * @remarks
 * Symmetric in sign: the error and its tolerance are both absolute, so a
 * negative value snaps exactly when its positive mirror does. A real
 * half-step (`-2.5`, which `Math.round` takes to `-2`) is `0.5` off and stays
 * fractional.
 */
const stepsFromZero = (value: number, step: number): number => {
  const exactSteps = value / step
  const nearestWholeSteps = Math.round(exactSteps)
  const roundingError = Math.abs(exactSteps - nearestWholeSteps)
  const toleranceAtThisSize = Math.max(1, Math.abs(exactSteps)) * FLOAT_ROUNDING_TOLERANCE
  const isWithinFloatRounding = roundingError <= toleranceAtThisSize
  return isWithinFloatRounding ? nearestWholeSteps : exactSteps
}

/** Whether `value` is a whole number of `step`s from zero, up to float rounding. */
const isWholeMultipleOf = (value: number, step: number): boolean =>
  Number.isInteger(stepsFromZero(value, step))

/** The nice step multipliers within one power of ten, coarsest first. */
const NICE_MULTIPLIERS_COARSEST_FIRST = [5, 2, 1] as const

/** How many times the requested interval count a finer step may split the axis into. */
const MAX_INTERVALS_PER_REQUESTED = 2

/**
 * The nice steps no coarser than `coarseStep`, from its power of ten and the
 * one below, coarsest first (`20` gives `20, 10, 5, 2, 1`).
 */
const niceStepsFinerThan = (coarseStep: number): readonly number[] => {
  const coarseExponent = Math.floor(Math.log10(coarseStep))
  return [coarseExponent, coarseExponent - 1]
    .flatMap((exponent) =>
      NICE_MULTIPLIERS_COARSEST_FIRST.map((multiplier) => multiplier * 10 ** exponent)
    )
    .filter((step) => step <= coarseStep)
}

/**
 * The tick step for `[low, high]`: the coarsest nice step, no coarser than the
 * one `count` intervals suggest, that both bounds are whole multiples of, so
 * the axis is labelled at its ends.
 *
 * @remarks
 * {@link niceDomain} rounds to a step taken from the padded extent, and the
 * rounding widens the domain past it, so the `coarseStep` this domain's own
 * width suggests can be one nice step too coarse and miss both bounds
 * (`[-40, 80]` labelled only `0` and `50`). Candidates come from
 * {@link niceStepsFinerThan}, coarsest first; one is taken only if it keeps at
 * most {@link MAX_INTERVALS_PER_REQUESTED} times `count` intervals. A domain
 * no candidate meets at both bounds keeps `coarseStep`.
 */
const stepFor = (low: number, high: number, count: number): number => {
  const width = high - low
  const coarseStep = niceStep(width / count)
  const maxIntervals = MAX_INTERVALS_PER_REQUESTED * count
  const keepsIntervalsReadable = (step: number): boolean => width / step <= maxIntervals
  const meetsBothBounds = (step: number): boolean =>
    isWholeMultipleOf(low, step) && isWholeMultipleOf(high, step)
  const boundAlignedStep = niceStepsFinerThan(coarseStep).find(
    (step) => keepsIntervalsReadable(step) && meetsBothBounds(step)
  )
  return boundAlignedStep ?? coarseStep
}

/**
 * The round values to label `domain` with.
 *
 * @returns Ascending ticks inside `domain`: at least two, and both bounds
 *   whenever they are round values themselves (as {@link niceDomain} makes
 *   them); a collapsed domain's one value
 */
const ticksFor = (domain: Domain, count: number = DEFAULT_TICK_COUNT): readonly number[] => {
  const [low, high] = domain
  if (!(high > low)) return [low]
  const step = stepFor(low, high, count)
  // Indexed off the step rather than accumulated, so a fractional step (`0.1`)
  // cannot drift a later tick off its round value. A bound that is a multiple
  // of the step is its own tick, exactly.
  const lowSteps = stepsFromZero(low, step)
  const highSteps = stepsFromZero(high, step)
  const first = Math.ceil(lowSteps)
  const last = Math.floor(highSteps)
  // Past `Number.MAX_SAFE_INTEGER` steps (a hairline domain at large
  // magnitude) `index + 1 === index`, so the loop below would never advance.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first >= MAX_TICKS) {
    return [low, high]
  }
  const ticks: number[] = []
  // `+ 0` turns the `-0` a zero tick gets from a negative `first` (`-0 * step`)
  // into `0`, so no formatter downstream prints a signed zero.
  for (let index = first; index <= last; index += 1) ticks.push(index * step + 0)
  if (first === lowSteps) ticks[0] = low + 0
  if (last === highSteps) ticks[ticks.length - 1] = high + 0
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
const plottedValuesOf = (series: ValueSeries): readonly number[] =>
  (series.kind === 'points' ? series.points : series.levels).flatMap((mark) => [
    mark.value,
    ...(mark.low === undefined ? [] : [mark.low]),
    ...(mark.high === undefined ? [] : [mark.high]),
  ])

/**
 * The lowest and highest of `values`, which must not be empty.
 *
 * @remarks
 * A fold rather than `Math.min(...values)`: an axis shared by several dense
 * series can hold more values than a spread call takes arguments.
 */
const extentOfValues = (values: readonly number[]): Domain =>
  values.reduce<Domain>(
    ([low, high], value) => [Math.min(low, value), Math.max(high, value)],
    [Infinity, -Infinity]
  )

/** A `'from-zero'` axis over `values`: zero to their highest, rounded up; `[0, 1]` when none is above zero. */
const fromZeroDomain = (values: readonly number[]): Domain => {
  const [, top] = extentOfValues(values)
  return top <= 0 ? [0, 1] : [0, niceDomain(0, top, DEFAULT_TICK_COUNT)[1]]
}

/**
 * The domain several series drawn on one axis need: every one's values and
 * bands, fitted as their `valueScale`s say.
 *
 * @remarks
 * Band bounds join the extent so a value inside its normal range still shows
 * the band around it. An axis whose series are all `'zero-to-one'` is pinned;
 * one with any `'from-zero'` series starts at zero whatever the values are.
 * Nothing to plot yields `[0, 1]`, so the axis draws empty rather than not at
 * all.
 */
const sharedDomainFor = (series: readonly ValueSeries[]): Domain => {
  if (series.every((member) => member.valueScale === 'zero-to-one')) return [0, 1]
  const values = series.flatMap(plottedValuesOf)
  if (values.length === 0) return [0, 1]
  if (series.some((member) => member.valueScale === 'from-zero')) return fromZeroDomain(values)
  const [low, high] = extentOfValues(values)
  return niceDomain(low, high, DEFAULT_TICK_COUNT)
}

/**
 * The domain a series' own values — and its bands — need, fitted as its
 * `valueScale` says: the axis it would get alone.
 */
const domainFor = (series: ValueSeries): Domain => sharedDomainFor([series])

/**
 * The least fraction of a shared axis' domain each of its series' own domains
 * must cover. Below it a series would be squashed into a sliver of the axis,
 * its changes unreadable beside the others'.
 */
const MIN_SHARED_COVERAGE = 1 / 3

/** How much of `domain` the part of `own` inside it covers, as a fraction. */
const coverageOf = (own: Domain, domain: Domain): number => {
  const width = domain[1] - domain[0]
  if (!(width > 0)) return 1
  const overlap = Math.min(own[1], domain[1]) - Math.max(own[0], domain[0])
  return Math.max(0, overlap) / width
}

/**
 * Whether two value scales can be drawn on one axis: `'fitted'` and
 * `'from-zero'` can, the shared axis then starting at zero; `'zero-to-one'`
 * only with itself.
 */
const scalesCanShare = (left: ValueScale, right: ValueScale): boolean =>
  (left === 'zero-to-one') === (right === 'zero-to-one')

/**
 * Whether `series` can join the axis `members` already share.
 *
 * @remarks
 * Three conditions, all needed:
 * - **Same unit**, and a unit at all: a series with `unit: null` never shares,
 *   since nothing says its values are comparable with another's.
 * - **Compatible scales**, as {@link scalesCanShare} says.
 * - **Similar ranges**: with `series` added, each member's own domain
 *   ({@link domainFor}) still covers at least {@link MIN_SHARED_COVERAGE} of
 *   the shared one ({@link sharedDomainFor}) — for a `'fitted'` member of an
 *   axis drawn from zero, of that from-zero domain. A `'fitted'` series with a
 *   value below zero never shares an axis drawn from zero, which would not
 *   hold it.
 */
const canJoin = (
  members: readonly [ValueSeries, ...ValueSeries[]],
  series: ValueSeries
): boolean => {
  const [first] = members
  if (series.unit === null || series.unit !== first.unit) return false
  if (!scalesCanShare(first.valueScale, series.valueScale)) return false
  const together = [...members, series]
  const isDrawnFromZero = together.some((member) => member.valueScale === 'from-zero')
  const holdsBelowZero = together.some(
    (member) => member.valueScale === 'fitted' && plottedValuesOf(member).some((value) => value < 0)
  )
  if (isDrawnFromZero && holdsBelowZero) return false
  const shared = sharedDomainFor(together)
  return together.every((member) => coverageOf(domainFor(member), shared) >= MIN_SHARED_COVERAGE)
}

/**
 * Group the selected series onto value axes and give each axis its side.
 *
 * @param selected - The series to plot, in selection order
 * @returns One axis per group, in the selection order of each group's first
 *   series, each listing its series in selection order
 * @throws When `selected` holds more than {@link CAP} series
 *
 * @remarks
 * Each series, in selection order, joins the first axis it {@link canJoin},
 * or opens a new one. Sides alternate in axis order, so the two most recently
 * opened axes never crowd the same gutter and an axis keeps its side as long
 * as nothing before it is removed.
 */
const assign = (selected: readonly ValueSeries[]): readonly ValueAxis[] => {
  if (selected.length > CAP) {
    throw new Error(`Plots draws at most ${CAP} series at once; got ${selected.length}`)
  }
  const groups: [ValueSeries, ...ValueSeries[]][] = []
  for (const series of selected) {
    const joined = groups.find((members) => canJoin(members, series))
    if (joined === undefined) groups.push([series])
    else joined.push(series)
  }
  return groups.map((members, position): ValueAxis => {
    const domain = sharedDomainFor(members)
    return {
      series: members,
      side: position % 2 === 0 ? 'left' : 'right',
      index: Math.floor(position / 2),
      domain,
      ticks: ticksFor(domain),
    }
  })
}

export type { Domain, ValueAxis }
export { CAP, assign, denormalise, domainFor, niceDomain, normalise, ticksFor }
