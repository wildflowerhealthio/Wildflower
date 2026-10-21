import type { JSX } from 'react'

import type { ColourSlots, SpanSeries, ValueAxis } from '@wildflowerhealthio/plots-fundamentals'

import { colourSlotOf, seriesColors, spanColour } from './series-colors.ts'
import { labelWithUnit } from './value-format.ts'
import styles from './legend.module.css'

interface LegendProps {
  /** The chart's value axes, in `ValueAxis.assign`'s order. */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /** Each value series' palette index, from `ColourSlots.assign`. */
  readonly colours: ColourSlots.ColourSlots
  /** The chart's span lanes, in selection order. */
  readonly lanes: readonly SpanSeries.SpanSeries[]
  /** Each lane's categories (`SpanSeries.categoriesOf`), parallel to `lanes`. */
  readonly laneCategories: readonly (readonly SpanSeries.SpanCategory[])[]
}

/**
 * The key above the figure: one entry per value series, axis by axis, a line
 * key in its colour beside its label and unit and the side its axis hangs on.
 *
 * @remarks
 * Present for every non-empty chart, one series included: with four synthetic
 * axes the legend is what ties an axis colour back to a name, so it is never
 * left to colour-matching. The key mirrors the mark (a short stroke for a
 * line) and the text stays in the text tokens.
 *
 * Each span lane follows as one entry: its label, then every category its
 * spans fall in (`laneCategories`), each keyed by a small bar in its lane
 * colour.
 */
const Legend = ({ axes, colours, lanes, laneCategories }: LegendProps): JSX.Element => (
  <ul className={styles.legend} aria-label="Series">
    {axes.flatMap((axis) =>
      axis.series.map((series) => (
        <li key={series.id} className={styles.entry}>
          <span
            className={styles.key}
            style={{ background: seriesColors(colourSlotOf(colours, series.id)).mark }}
            aria-hidden="true"
          />
          <span className={styles.label}>{labelWithUnit(series)}</span>
          <span className={styles.side}>{axis.side === 'left' ? 'left axis' : 'right axis'}</span>
        </li>
      ))
    )}
    {lanes.map((lane, position) => (
      <li key={lane.id} className={styles.entry}>
        <span className={styles.label}>{lane.label}</span>
        <ul className={styles['legend__categories']} aria-label={`${lane.label} categories`}>
          {laneCategories[position].map((category) => (
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
