import type { JSX } from 'react'

import type { ValueAxis } from '@wildflowerhealthio/health-viewer-fundamentals'

import { seriesColors } from './series-colors.ts'
import { labelWithUnit } from './value-format.ts'
import styles from './legend.module.css'

interface LegendProps {
  /** The chart's value axes, in selection order. */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /** Each axis' palette index, parallel to `axes`. */
  readonly colours: readonly number[]
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
 */
const Legend = ({ axes, colours }: LegendProps): JSX.Element => (
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
  </ul>
)

export type { LegendProps }
export { Legend }
