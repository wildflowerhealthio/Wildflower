import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { walkthroughAnchor } from '@wildflowerhealthio/walkthrough-core'
import type { JSX, ReactNode } from 'react'
import { useId, useState } from 'react'

import { PlotsWalkthroughAnchor } from './walkthrough-anchors.ts'
import styles from './plots-layout.module.css'

interface PlotsLayoutProps {
  /** The series picker, docked beside the view or folded above it. */
  readonly seriesPanel: ReactNode
  /** How many series are selected, for the narrow layout's disclosure label. */
  readonly selectedSeriesCount: number
  /** The range presets, on the toolbar above the view. */
  readonly rangePresets: ReactNode
  /** The view switch, beside the range presets. */
  readonly viewSwitch: ReactNode
  /**
   * A note on the toolbar's controls — why one is disabled — full width above
   * them; omitted or `null` when there is nothing to say.
   */
  readonly toolbarNote?: ReactNode
  /** A loading or error line, shown under the toolbar; omitted or `null` when there is nothing to say. */
  readonly status?: ReactNode
  /** The selection in the shown view: the chart, the table or the scatter. */
  readonly children: ReactNode
}

/**
 * The viewer page: the series panel and the view column, with the toolbar —
 * the range presets and the view switch, under any note on them — and any
 * status line above the view.
 *
 * @remarks
 * From 900px wide the panel is an 18rem column beside the view and always
 * shown. Narrower, the page is one column and the panel folds behind a
 * `Series (n selected)` disclosure above the view, closed at first. The
 * breakpoint lives only in the stylesheet: the disclosure is a button with
 * `aria-expanded` rather than a `<details>`, because a closed `<details>`
 * hides its content whatever the CSS says, so docking the same panel on a
 * wide viewport would need a second copy of it or a JS media query.
 *
 * The panel, the presets and the view switch each carry their
 * {@link PlotsWalkthroughAnchor} for the app's walkthrough; the presets and
 * the view switch sit in a box of their own to carry it.
 */
const PlotsLayout = ({
  seriesPanel,
  selectedSeriesCount,
  rangePresets,
  viewSwitch,
  toolbarNote,
  status,
  children,
}: PlotsLayoutProps): JSX.Element => {
  const [panelIsOpen, setPanelIsOpen] = useState(false)
  const panelBodyId = useId()
  return (
    <div className={styles.layout}>
      <aside
        className={styles.panel}
        aria-label="Series"
        {...walkthroughAnchor(PlotsWalkthroughAnchor.seriesPanel)}
      >
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
        {toolbarNote}
        <div className={styles.toolbar}>
          <div
            className={styles['toolbar-control']}
            {...walkthroughAnchor(PlotsWalkthroughAnchor.rangePresets)}
          >
            {rangePresets}
          </div>
          <div
            className={styles['toolbar-control']}
            {...walkthroughAnchor(PlotsWalkthroughAnchor.viewSwitch)}
          >
            {viewSwitch}
          </div>
        </div>
        {status !== undefined && status !== null && <div className={styles.status}>{status}</div>}
        <div className={styles.chart}>{children}</div>
      </div>
    </div>
  )
}

export { PlotsLayout }
export type { PlotsLayoutProps }
