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
   * that {@link assign} found share a unit and a similar magnitude.
   */
  readonly series: readonly [ValueSeries, ...ValueSeries[]]
  /**
   * The unit this axis' series share when there are several of them, and
   * `null` when it has one. A renderer branches on this, not on counting
   * `series`: a shared axis is labelled with this unit and drawn in no one
   * series' colour.
   */
  readonly sharedUnit: string | null
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

/**
 * The lowest and highest value or band bound `series` plots, which its axis
 * must contain; `null` when it plots nothing.
 *
 * @remarks
 * Raw: no padding and no rounding. One pass over the marks with two running
 * bounds, since a dense series can hold tens of thousands of readings and
 * {@link assign} reads every selected series on each selection change.
 */
const extentOf = (series: ValueSeries): Domain | null => {
  let low = Infinity
  let high = -Infinity
  for (const mark of series.kind === 'points' ? series.points : series.levels) {
    low = Math.min(low, mark.value)
    high = Math.max(high, mark.value)
    if (mark.low !== undefined) {
      low = Math.min(low, mark.low)
      high = Math.max(high, mark.low)
    }
    if (mark.high !== undefined) {
      low = Math.min(low, mark.high)
      high = Math.max(high, mark.high)
    }
  }
  return low <= high ? [low, high] : null
}

/** A series with its raw {@link extentOf}, read once so grouping never reads its values again. */
interface Measured {
  readonly series: ValueSeries
  readonly extent: Domain | null
}

/** `series` with its extent. */
const measure = (series: ValueSeries): Measured => ({ series, extent: extentOf(series) })

/** The extents of `members` that plot anything. */
const extentsOf = (members: readonly Measured[]): readonly Domain[] =>
  members.flatMap(({ extent }) => (extent === null ? [] : [extent]))

/**
 * The domain an axis drawn against `members` needs: every one's values and
 * bands, fitted as their `valueScale`s say.
 *
 * @remarks
 * Built from the members' raw extents, so rounding happens once, on this
 * final domain. Band bounds are in the extents so a value inside its normal
 * range still shows the band around it. An axis whose series are all
 * `'zero-to-one'` is pinned to `[0, 1]`. One with any `'from-zero'` series
 * starts at zero and rounds its highest value up, or is `[0, 1]` when nothing
 * is above zero. Otherwise the extent is padded and rounded by
 * {@link niceDomain}. Nothing to plot yields `[0, 1]`, so the axis draws empty
 * rather than not at all.
 */
const domainOfMembers = (members: readonly Measured[]): Domain => {
  if (members.every(({ series }) => series.valueScale === 'zero-to-one')) return [0, 1]
  const extents = extentsOf(members)
  if (extents.length === 0) return [0, 1]
  const low = Math.min(...extents.map(([extentLow]) => extentLow))
  const high = Math.max(...extents.map(([, extentHigh]) => extentHigh))
  if (members.some(({ series }) => series.valueScale === 'from-zero')) {
    return high <= 0 ? [0, 1] : [0, niceDomain(0, high, DEFAULT_TICK_COUNT)[1]]
  }
  return niceDomain(low, high, DEFAULT_TICK_COUNT)
}

/**
 * The domain a series' own values — and its bands — need, fitted as its
 * `valueScale` says: the axis it gets when it shares with none.
 */
const domainFor = (series: ValueSeries): Domain => domainOfMembers([measure(series)])

/**
 * How many times its lowest value a shared axis' highest may be: series whose
 * values sit within a factor of three of each other share, so lines near each
 * other relative to their size are read on one scale, and series an order of
 * magnitude apart keep their own axes.
 *
 * @remarks
 * Systolic and diastolic blood pressure (`118–142` and `76–92 mm[Hg]`) span
 * under twice their low and share; heart rate and respiratory rate (`60–100`
 * and `12–20 /min`) span over eight times and do not. On an axis drawn from
 * zero the lowest value is zero, so there the ratio is between the highest
 * values: each member's own highest must be at least a third of the axis'.
 */
const MAX_SHARED_RATIO = 3

/**
 * Whether two value scales can be drawn on one axis: `'fitted'` and
 * `'from-zero'` can, the shared axis then starting at zero; `'zero-to-one'`
 * only with itself.
 *
 * @remarks
 * No source produces a `'zero-to-one'` series that can share yet: booleans
 * are the only ones, and they carry no unit. Booleans sharing one `[0, 1]`
 * axis is planned, and this branch is what they will take.
 */
const scalesCanShare = (left: ValueScale, right: ValueScale): boolean =>
  (left === 'zero-to-one') === (right === 'zero-to-one')

/**
 * Whether the values of `together`, drawn on one axis, are of a similar
 * magnitude, as {@link MAX_SHARED_RATIO} measures it on their raw extents.
 *
 * @remarks
 * A `'fitted'` series with a value at or below zero is never of a similar
 * magnitude to anything: a ratio means nothing there. An all-`'zero-to-one'`
 * axis is pinned to `[0, 1]` whatever its values, so its series always are.
 */
const haveSimilarMagnitude = (together: readonly Measured[]): boolean => {
  if (together.every(({ series }) => series.valueScale === 'zero-to-one')) return true
  const holdsZeroOrBelow = together.some(
    ({ series, extent }) => series.valueScale === 'fitted' && extent !== null && extent[0] <= 0
  )
  if (holdsZeroOrBelow) return false
  const extents = extentsOf(together)
  const sharedHigh = Math.max(...extents.map(([, high]) => high))
  if (together.some(({ series }) => series.valueScale === 'from-zero')) {
    return extents.every(([, high]) => high * MAX_SHARED_RATIO >= sharedHigh)
  }
  const sharedLow = Math.min(...extents.map(([low]) => low))
  return sharedHigh <= sharedLow * MAX_SHARED_RATIO
}

/**
 * Whether `candidate` can join the axis `members` already share.
 *
 * @remarks
 * Four conditions, all needed:
 * - **Same unit**, and a unit at all: a series with `unit: null` never shares,
 *   since nothing says its values are comparable with another's.
 * - **Something plotted**: a series with no values has no magnitude to
 *   compare, so it keeps an axis of its own.
 * - **Compatible scales**, as {@link scalesCanShare} says.
 * - **Similar magnitude**, as {@link haveSimilarMagnitude} says of the
 *   members with `candidate` added.
 */
const canJoin = (members: readonly [Measured, ...Measured[]], candidate: Measured): boolean => {
  const [first] = members
  if (candidate.series.unit === null || candidate.series.unit !== first.series.unit) return false
  if (candidate.extent === null || members.some(({ extent }) => extent === null)) return false
  if (!scalesCanShare(first.series.valueScale, candidate.series.valueScale)) return false
  return haveSimilarMagnitude([...members, candidate])
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
 * Each series' extent is read once, then each series, in selection order,
 * joins the first axis it {@link canJoin}, or opens a new one. Sides
 * alternate in axis order, so the two most recently opened axes never crowd
 * the same gutter and an axis keeps its side as long as nothing before it is
 * removed.
 */
const assign = (selected: readonly ValueSeries[]): readonly ValueAxis[] => {
  if (selected.length > CAP) {
    throw new Error(`Plots draws at most ${CAP} series at once; got ${selected.length}`)
  }
  const groups: [Measured, ...Measured[]][] = []
  for (const candidate of selected.map(measure)) {
    const joined = groups.find((members) => canJoin(members, candidate))
    if (joined === undefined) groups.push([candidate])
    else joined.push(candidate)
  }
  return groups.map((members, position): ValueAxis => {
    const domain = domainOfMembers(members)
    const [first, ...others] = members
    return {
      series: [first.series, ...others.map(({ series }) => series)],
      sharedUnit: others.length === 0 ? null : first.series.unit,
      side: position % 2 === 0 ? 'left' : 'right',
      index: Math.floor(position / 2),
      domain,
      ticks: ticksFor(domain),
    }
  })
}

export type { Domain, ValueAxis }
export { CAP, MAX_SHARED_RATIO, assign, denormalise, domainFor, niceDomain, normalise, ticksFor }
