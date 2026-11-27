import type { PlanTotals } from '@wildflowerhealthio/importer-fundamentals'
import { Notice } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useId } from 'react'

import { COMPLETE_HEADING, completeLine, IMPORT_MORE_FILES_LABEL } from './plan-text.ts'
import styles from './import-complete-notice.module.css'

/** What {@link ImportCompleteNotice} shows and does. */
interface ImportCompleteNoticeProps {
  /** The totals of the plan that was written. */
  readonly totals: PlanTotals.Type
  readonly onImportMore: () => void
}

/**
 * Said once the plan is written: the page's heading, then a success notice
 * of how many records were created, updated and linked, with a way to import
 * more files.
 */
const ImportCompleteNotice = ({ totals, onImportMore }: ImportCompleteNoticeProps): JSX.Element => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={styles['import-complete-notice']}>
      <h2 id={headingId} className={styles['import-complete-notice__heading']}>
        {COMPLETE_HEADING}
      </h2>
      <Notice tone="success" action={{ label: IMPORT_MORE_FILES_LABEL, onClick: onImportMore }}>
        {completeLine(totals.overall)}
      </Notice>
    </section>
  )
}

export { ImportCompleteNotice }
export type { ImportCompleteNoticeProps }
