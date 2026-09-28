import type { DateTime } from 'effect'
import type { JSX } from 'react'

import { type Level, Series, type ValueAxis } from 'health-viewer-fundamentals'

import { seriesColors } from './series-colors.ts'
import { formatDate, formatReading } from './value-format.ts'
import styles from './crosshair-tooltip.module.css'

interface CrosshairTooltipProps {
  /** The chart's value axes, in selection order. */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /** Each axis' palette index, parallel to `axes`. */
  readonly colours: readonly number[]
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
 * The value is followed by the series' unit and the level's `note` — the
 * domain's qualifier (`per day`), shown as given. The detail line says how
 * old the value is: a point series' level starts at the reading it holds, so
 * it names that reading's date; a level series' level is a stated span, so it
 * names the span, open ones `ongoing`.
 *
 * `null` is a real answer, not a gap: a point series only yields it when
 * empty, and a level series in a gap between its levels, where nothing was in
 * effect.
 */
const readoutText = (series: Series.Series, level: Level.Level | null): ReadoutText => {
  if (level === null) return { value: '—', detail: null }
  const value = [formatReading(level.value), series.unit, level.note]
    .filter((part) => part !== null && part !== undefined)
    .join(' ')
  const detail =
    series.kind === 'points'
      ? formatDate(level.start)
      : `${formatDate(level.start)} – ${level.end === null ? 'ongoing' : formatDate(level.end)}`
  return { value, detail }
}

/**
 * The crosshair's readout: every axis' series read at `time`, one row each,
 * in axis order.
 *
 * @remarks
 * HTML rather than `Plot.tip`, which describes a single datum; this lists every
 * series whether or not the pointer is on its line. Each row leads with the
 * value, keys its series with a short stroke of its colour, and says when the
 * value it shows took effect (see {@link readoutText}).
 */
const CrosshairTooltip = ({
  axes,
  colours,
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
      {axes.map((axis, position) => {
        const text = readoutText(axis.series, Series.levelAt(axis.series, time))
        return (
          <li key={axis.series.id} className={styles.row} data-testid="crosshair-row">
            <span
              className={styles.key}
              style={{ background: seriesColors(colours[position]).mark }}
              aria-hidden="true"
            />
            <span className={styles.value}>{text.value}</span>
            <span className={styles.label}>{axis.series.label}</span>
            {text.detail === null ? null : <span className={styles.detail}>{text.detail}</span>}
          </li>
        )
      })}
    </ul>
  </div>
)

export type { CrosshairTooltipProps }
export { CrosshairTooltip }
