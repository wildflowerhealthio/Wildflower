import { LinkButton } from '@wildflowerhealthio/react-tundraish'
import type { Option } from 'effect'
import type { JSX } from 'react'

import { ImportBar } from './import-bar.tsx'
import { CANCEL_IMPORT_LABEL } from './plan-text.ts'
import { SummaryCard } from './summary-card.tsx'
import type { Review } from './use-import-plan-page.ts'
import type * as WriteFailure from './write-failure.ts'
import styles from './import-plan-page.module.css'

/** What {@link ImportPlanPage} shows and does. */
interface ImportPlanPageProps {
  readonly review: Review
  /** Why the last write did not end in an import, when one was sent. */
  readonly writeFailure: Option.Option<WriteFailure.Type>
  /** Whether the write is in flight: there is no way to leave the page until it settles. */
  readonly importing: boolean
  readonly onImport: () => void
  readonly onCancel: () => void
}

/**
 * The import plan under review: the summary, the import bar and a way to
 * cancel, in one column. While the write is in flight there is no Cancel
 * import, since the write lands whatever the page shows.
 */
const ImportPlanPage = ({
  review,
  writeFailure,
  importing,
  onImport,
  onCancel,
}: ImportPlanPageProps): JSX.Element => (
  <section aria-label="Import plan" className={styles['import-plan-page']}>
    <SummaryCard totals={review.totals} batchCopies={review.batchCopies} />
    <ImportBar
      review={review}
      writeFailure={writeFailure}
      importing={importing}
      onImport={onImport}
    />
    {importing ? null : (
      <LinkButton className={styles['import-plan-page__cancel']} onClick={onCancel}>
        {CANCEL_IMPORT_LABEL}
      </LinkButton>
    )}
  </section>
)

export { ImportPlanPage }
export type { ImportPlanPageProps }
