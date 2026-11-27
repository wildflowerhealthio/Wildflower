import type { PlanTotals } from '@wildflowerhealthio/importer-fundamentals'
import type { JSX } from 'react'

import { COMPLETE_HEADING, completeLine, IMPORT_MORE_FILES_LABEL } from './plan-text.ts'
import styles from './import-complete-notice.module.css'

/** What {@link ImportCompleteNotice} shows and does. */
interface ImportCompleteNoticeProps {
  /** The totals of the plan that was written. */
  readonly totals: PlanTotals.Type
  readonly onImportMore: () => void
}

/** Said once the plan is written: how many records were created, updated and linked. */
const ImportCompleteNotice = ({ totals, onImportMore }: ImportCompleteNoticeProps): JSX.Element => {
  return (
    <section aria-label={COMPLETE_HEADING} className={styles['import-complete-notice']}>
      <h2 className={styles['import-complete-notice__heading']}>{COMPLETE_HEADING}</h2>
      <p role="status" className={`text-body-4 ${styles['import-complete-notice__line']}`}>
        {completeLine(totals.overall)}
      </p>
      <button
        type="button"
        className={`button-3 outline ${styles['import-complete-notice__button']}`}
        onClick={onImportMore}
      >
        {IMPORT_MORE_FILES_LABEL}
      </button>
    </section>
  )
}

export { ImportCompleteNotice }
export type { ImportCompleteNoticeProps }
