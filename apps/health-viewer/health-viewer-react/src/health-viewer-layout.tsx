import type { JSX, ReactNode } from 'react'
import { useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './health-viewer-layout.module.css'

interface HealthViewerLayoutProps {
  /** The series picker, docked beside the chart or folded above it. */
  readonly seriesPanel: ReactNode
  /** How many series are selected, for the narrow layout's disclosure label. */
  readonly selectedSeriesCount: number
  /** The range presets, on the row above the chart. */
  readonly rangePresets: ReactNode
  /** A loading or error line, shown under the presets; omitted or `null` when there is nothing to say. */
  readonly status?: ReactNode
  /** The chart. */
  readonly children: ReactNode
}

/**
 * The viewer page: the series panel and the chart column, with the range
 * presets (and any status line) above the chart.
 *
 * @remarks
 * From 900px wide the panel is an 18rem column beside the chart and always
 * shown. Narrower, the page is one column and the panel folds behind a
 * `Series (n selected)` disclosure above the chart, closed at first. The
 * breakpoint lives only in the stylesheet: the disclosure is a button with
 * `aria-expanded` rather than a `<details>`, because a closed `<details>`
 * hides its content whatever the CSS says, so docking the same panel on a
 * wide viewport would need a second copy of it or a JS media query.
 */
const HealthViewerLayout = ({
  seriesPanel,
  selectedSeriesCount,
  rangePresets,
  status,
  children,
}: HealthViewerLayoutProps): JSX.Element => {
  const [panelIsOpen, setPanelIsOpen] = useState(false)
  const panelBodyId = useId()
  return (
    <div className={styles.layout}>
      <aside className={styles.panel} aria-label="Series">
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={panelIsOpen}
          aria-controls={panelBodyId}
          onClick={() => {
            setPanelIsOpen((wasOpen) => !wasOpen)
          }}
        >
          <span
            className={panelIsOpen ? styles['triangle-open'] : styles['triangle-closed']}
            aria-hidden="true"
          />
          Series ({selectedSeriesCount} selected)
        </button>
        <div
          id={panelBodyId}
          className={cn(styles['panel-body'], !panelIsOpen && styles['panel-body-folded'])}
        >
          {seriesPanel}
        </div>
      </aside>
      <div className={styles.main}>
        <div className={styles.toolbar}>{rangePresets}</div>
        {status !== undefined && status !== null && <div className={styles.status}>{status}</div>}
        <div className={styles.chart}>{children}</div>
      </div>
    </div>
  )
}

export { HealthViewerLayout }
export type { HealthViewerLayoutProps }
