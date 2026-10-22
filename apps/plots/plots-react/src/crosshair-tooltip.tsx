import type { DateTime } from 'effect'
import type { JSX } from 'react'

import {
  Buckets,
  type ColourSlots,
  type Level,
  Series,
  SpanSeries,
  type ValueAxis,
} from '@wildflowerhealthio/plots-fundamentals'

import { colourSlotOf, seriesColors, spanColour } from './series-colors.ts'
import { formatDate, formatDateTime, formatReading, readingWithUnit } from './value-format.ts'
import styles from './crosshair-tooltip.module.css'

interface CrosshairTooltipProps {
  /** The chart's value axes, in `ValueAxis.assign`'s order. */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /** Each value series' palette index, from `ColourSlots.assign`. */
  readonly colours: ColourSlots.ColourSlots
  /** The chart's span lanes, in selection order. */
  readonly lanes: readonly SpanSeries.SpanSeries[]
  /**
   * The series drawn as buckets, from `Buckets.ofDenseSeries` — the map the
   * figure and the crosshair's stops were built from. Their rows read the
   * bucket under the crosshair rather than a reading.
   */
  readonly bucketsBySeriesId: ReadonlyMap<string, readonly Buckets.Bucket[]>
  /** The instant the crosshair sits on. */
  readonly time: DateTime.Utc
  /** The crosshair's horizontal position inside the figure, in pixels. */
  readonly left: number
  /** Hang the tooltip to the crosshair's left, for a crosshair too near the figure's right edge to fit it. */
  readonly flip: boolean
}

/** The value column and the detail line beneath the label, for one series at the crosshair. */
interface ReadoutText {
  readonly value: string
  readonly detail: string | null
}

/**
 * What one row says for `series` at the crosshair, given the level
 * `Series.levelAt` found there.
 *
 * @remarks
 * The value reads as `readingWithUnit` writes it. The detail line says how
 * old the value is: a point series' level starts at the reading it holds, so
 * it names that reading's date; a level series' level is a stated span, so it
 * names the span, open ones `ongoing`.
 *
 * `null` is a real answer, not a gap: a point series only yields it when
 * empty, and a level series in a gap between its levels, where nothing was in
 * effect.
 */
const readoutText = (series: Series.ValueSeries, level: Level.Level | null): ReadoutText => {
  if (level === null) return { value: '—', detail: null }
  const value = readingWithUnit(series, level)
  const detail =
    series.kind === 'points'
      ? formatDate(level.start)
      : `${formatDate(level.start)} – ${level.end === null ? 'ongoing' : formatDate(level.end)}`
  return { value, detail }
}

/**
 * What one row says for a bucketed `series` at the crosshair, given the bucket
 * `Buckets.at` found there: the bucket's mean in the series' unit, and a
 * detail line saying it is a mean, of how many readings, and their range.
 *
 * @remarks
 * `null` is a gap — no reading fell in the slice under the crosshair — and
 * reads as one. A bucket of one reading is that reading, so it says only that.
 */
const bucketReadoutText = (
  series: Series.ValueSeries,
  bucket: Buckets.Bucket | null
): ReadoutText => {
  if (bucket === null) return { value: '—', detail: null }
  const value = [formatReading(bucket.mean), series.unit].filter((part) => part !== null).join(' ')
  const detail =
    bucket.count === 1
      ? '1 reading'
      : `mean of ${bucket.count} readings, ${formatReading(bucket.min)}–${formatReading(bucket.max)}`
  return { value, detail }
}

interface SpanRowsProps {
  readonly lane: SpanSeries.SpanSeries
  readonly time: DateTime.Utc
}

/**
 * A lane's rows in the readout: one per span covering `time`
 * (`SpanSeries.spansAt`), keyed in its category's colour, naming the category
 * over the lane's label and the span's start and end — or one row of `—` in a
 * gap, so every lane is accounted for.
 */
const SpanRows = ({ lane, time }: SpanRowsProps): JSX.Element => {
  const covering = SpanSeries.spansAt(lane, time)
  if (covering.length === 0) {
    return (
      <li className={styles.row} data-testid="crosshair-row">
        <span className={styles['tooltip__span-key']} aria-hidden="true" />
        <span className={styles.value}>—</span>
        <span className={styles.label}>{lane.label}</span>
      </li>
    )
  }
  return (
    <>
      {covering.map((span) => (
        <li
          key={`${span.category.id}:${span.start.epochMillis}`}
          className={styles.row}
          data-testid="crosshair-row"
        >
          <span
            className={styles['tooltip__span-key']}
            style={{ background: spanColour(span.category.colourSlot) }}
            aria-hidden="true"
          />
          <span className={styles.value}>{span.category.label}</span>
          <span className={styles.label}>{lane.label}</span>
          <span className={styles.detail}>
            {`${formatDateTime(span.start)} – ${formatDateTime(span.end)}`}
          </span>
        </li>
      ))}
    </>
  )
}

/**
 * The crosshair's readout: every axis' series read at `time`, one row each,
 * in axis order, then each span lane's rows ({@link SpanRows}).
 *
 * @remarks
 * HTML rather than `Plot.tip`, which describes a single datum; this lists every
 * series whether or not the pointer is on its line. Each row leads with the
 * value, keys its series with a short stroke of its colour, and says when the
 * value it shows took effect (see {@link readoutText}) — or, for a bucketed
 * series, what the bucket's mean summarises (see {@link bucketReadoutText}).
 */
const CrosshairTooltip = ({
  axes,
  colours,
  lanes,
  bucketsBySeriesId,
  time,
  left,
  flip,
}: CrosshairTooltipProps): JSX.Element => (
  <div
    className={flip ? `${styles.tooltip} ${styles.flipped}` : styles.tooltip}
    style={{ left }}
    role="status"
    aria-label="Values at the crosshair"
  >
    <p className={styles.time}>{formatDate(time)}</p>
    <ul className={styles.rows}>
      {axes
        .flatMap((axis) => axis.series)
        .map((series) => {
          const buckets = bucketsBySeriesId.get(series.id)
          const text =
            buckets === undefined
              ? readoutText(series, Series.levelAt(series, time))
              : bucketReadoutText(series, Buckets.at(buckets, time))
          return (
            <li key={series.id} className={styles.row} data-testid="crosshair-row">
              <span
                className={styles.key}
                style={{ background: seriesColors(colourSlotOf(colours, series.id)).mark }}
                aria-hidden="true"
              />
              <span className={styles.value}>{text.value}</span>
              <span className={styles.label}>{series.label}</span>
              {text.detail === null ? null : <span className={styles.detail}>{text.detail}</span>}
            </li>
          )
        })}
      {lanes.map((lane) => (
        <SpanRows key={lane.id} lane={lane} time={time} />
      ))}
    </ul>
  </div>
)

export type { CrosshairTooltipProps }
export { CrosshairTooltip }
