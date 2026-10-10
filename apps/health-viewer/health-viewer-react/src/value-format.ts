import type { DateTime } from 'effect'

import { type Series, ValueAxis } from '@wildflowerhealthio/health-viewer-fundamentals'

/** Slack, in powers of ten, for float error in a tick step read back from two ticks. */
const STEP_TOLERANCE = 1e-9

/**
 * Decimal places an axis labels its ticks with — as many as its tick step
 * needs and no more, so `0.5`-step ticks read `1.5` and `20`-step ticks `40`.
 *
 * @remarks
 * `ValueAxis.ticksFor` places ticks 1, 2 or 5 times a power of ten apart, so the step's
 * leading decimal place is its last significant one. The step is read back as
 * the difference of two `index * step` ticks, which can land a hair under the
 * true step (`57 * 0.1 - 56 * 0.1` is `0.0999…64`); {@link STEP_TOLERANCE}
 * keeps that from flooring to one decimal place too many.
 */
const tickDecimals = (axis: ValueAxis.ValueAxis): number => {
  const [first, second] = axis.ticks
  const [low, high] = axis.domain
  const step = second === undefined ? high - low : second - first
  if (!(step > 0) || !Number.isFinite(step)) return 0
  return Math.min(20, Math.max(0, -Math.floor(Math.log10(step) + STEP_TOLERANCE)))
}

/** The formatter behind {@link formatAxisValue}, built once per axis rather than per tick. */
const axisValueFormat = (decimals: number): Intl.NumberFormat =>
  new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: 'negative',
  })

/**
 * Render one axis value at a fixed number of decimals, grouped the viewer's way.
 *
 * @remarks
 * `signDisplay: 'negative'` keeps a label from reading `-0`: `ValueAxis.ticksFor`
 * never returns negative zero, but the `0..1` round trip can land a zero tick a hair
 * below it, and a value that rounds to zero at `decimals` would otherwise keep
 * its sign.
 */
const formatAxisValue = (value: number, decimals: number): string =>
  axisValueFormat(decimals).format(value)

/**
 * The tick label formatter for `axis`, which Plot calls with a position
 * on the shared `0..1` scale.
 *
 * @remarks
 * The position is mapped back through the axis' own domain, so the label
 * names the series' value. Rounding to {@link tickDecimals} is what absorbs the
 * float error of that round trip (`0.30000000000000004` reads `0.3`).
 */
const axisTickFormat = (axis: ValueAxis.ValueAxis): ((fraction: number) => string) => {
  const format = axisValueFormat(tickDecimals(axis))
  return (fraction) => format.format(ValueAxis.denormalise(fraction, axis.domain))
}

/** Most decimals a reading shows in the tooltip — enough for any source's values, few enough to read. */
const READING_DECIMALS = 2

/** Built once: the tooltip formats a row per series on every crosshair move. */
const readingFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: READING_DECIMALS,
  signDisplay: 'negative',
})

/** Render one value for the crosshair readout, dropping trailing zeroes. */
const formatReading = (value: number): string => readingFormat.format(value)

/** Built once, like {@link readingFormat}. */
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** The viewer-local calendar date an instant falls on, e.g. `Mar 4, 2024`. */
const formatDate = (time: DateTime.Utc): string => dateFormat.format(time.epochMillis)

/** A series' name with its unit, e.g. `Glucose (mmol/L)` — what its axis and legend entry say. */
const labelWithUnit = (series: Series.Series): string =>
  series.unit === null ? series.label : `${series.label} (${series.unit})`

export { axisTickFormat, formatAxisValue, formatDate, formatReading, labelWithUnit, tickDecimals }
