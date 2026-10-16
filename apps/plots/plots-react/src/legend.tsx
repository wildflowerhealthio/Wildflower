import type { JSX } from 'react'

import { SpanSeries, type ValueAxis } from '@wildflowerhealthio/plots-fundamentals'

import { seriesColors, spanColour } from './series-colors.ts'
import { labelWithUnit } from './value-format.ts'
import styles from './legend.module.css'

interface LegendProps {
  /** The chart's value axes, in selection order. */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /** Each axis' palette index, parallel to `axes`. */
  readonly colours: readonly number[]
  /** The chart's span lanes, in selection order. */
  readonly lanes: readonly SpanSeries.SpanSeries[]
}

/**
 * The key above the figure: one entry per axis, a line key in its series'
 * colour beside its label and unit.
 *
 * @remarks
 * Present for every non-empty chart, one series included: with four synthetic
 * axes the legend is what ties an axis colour back to a name, so it is never
 * left to colour-matching. The key mirrors the mark (a short stroke for a
 * line) and the text stays in the text tokens.
 *
 * Each span lane follows as one entry: its label, then every category its
 * spans fall in (`SpanSeries.categoriesOf`), each keyed by a small bar in its
 * lane colour.
 */
const Legend = ({ axes, colours, lanes }: LegendProps): JSX.Element => (
  <ul className={styles.legend} aria-label="Series">
    {axes.map((axis, position) => (
      <li key={axis.series.id} className={styles.entry}>
        <span
          className={styles.key}
          style={{ background: seriesColors(colours[position]).mark }}
          aria-hidden="true"
        />
        <span className={styles.label}>{labelWithUnit(axis.series)}</span>
        <span className={styles.side}>{axis.side === 'left' ? 'left axis' : 'right axis'}</span>
      </li>
    ))}
    {lanes.map((lane) => (
      <li key={lane.id} className={styles.entry}>
        <span className={styles.label}>{lane.label}</span>
        <ul className={styles['legend__categories']} aria-label={`${lane.label} categories`}>
          {SpanSeries.categoriesOf(lane).map((category) => (
            <li key={category.id} className={styles['legend__category']}>
              <span
                className={styles['legend__span-key']}
                style={{ background: spanColour(category.colourSlot) }}
                aria-hidden="true"
              />
              <span className={styles.label}>{category.label}</span>
            </li>
          ))}
        </ul>
        <span className={styles.side}>lane</span>
      </li>
    ))}
  </ul>
)

export type { LegendProps }
export { Legend }
