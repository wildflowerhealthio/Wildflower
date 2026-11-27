import type { FormatKind, FormatSettings } from '@wildflowerhealthio/importer-core'
import type { RecordChoice, RecordKey } from '@wildflowerhealthio/importer-fundamentals'
import { LinkButton } from '@wildflowerhealthio/react-tundraish'
import type { Option } from 'effect'
import type { JSX } from 'react'

import { DecidedAutomatically } from './decided-automatically.tsx'
import { ImportBar } from './import-bar.tsx'
import { NeedsADecision } from './needs-a-decision.tsx'
import { CANCEL_IMPORT_LABEL } from './plan-text.ts'
import { SummaryCard } from './summary-card.tsx'
import type { Review, SettingsStatus } from './use-import-plan-page.ts'
import type * as WriteFailure from './write-failure.ts'
import styles from './import-plan-page.module.css'

/** What {@link ImportPlanPage} shows and does. */
interface ImportPlanPageProps {
  readonly review: Review
  /** Why the last write did not end in an import, when one was sent. */
  readonly writeFailure: Option.Option<WriteFailure.Type>
  /** Whether the write is in flight: there is no way to leave the page until it settles. */
  readonly importing: boolean
  /** Every format's settings as the reviewer last set them. */
  readonly settings: FormatSettings
  /** Whether the plan shown was read under `settings`: Import waits while it is read again. */
  readonly settingsStatus: SettingsStatus
  /** How many of the reviewer's choices the last read again could not keep. */
  readonly choicesNotKept: number
  /** Make `choice` the reviewer's choice for every record under one of `keys`. */
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  /** Clear the reviewer's choice for every record under one of `keys`, back to its suggestion. */
  readonly onReset: (keys: Iterable<RecordKey.Type>) => void
  /** Make `formatSettings` `format`'s settings, and read its files again under them. */
  readonly onApplySettings: <K extends FormatKind>(
    format: K,
    formatSettings: FormatSettings[K]
  ) => void
  /** Read again every format whose settings were not applied. */
  readonly onApplySettingsAgain: () => void
  readonly onImport: () => void
  readonly onCancel: () => void
}

/**
 * The import plan under review: the summary, the records that need a
 * decision, the import bar, the records decided automatically with each
 * file's Settings, and a way to cancel, in one column. While the
 * write is in flight there is no Cancel import, since the write lands
 * whatever the page shows. While the files are read again under changed
 * settings the plan under review stays and Import waits; settings that were
 * not applied, and choices a read again could not keep, are said above the
 * import bar.
 */
const ImportPlanPage = ({
  review,
  writeFailure,
  importing,
  settings,
  settingsStatus,
  choicesNotKept,
  onChoose,
  onReset,
  onApplySettings,
  onApplySettingsAgain,
  onImport,
  onCancel,
}: ImportPlanPageProps): JSX.Element => (
  <section aria-label="Import plan" className={styles['import-plan-page']}>
    <SummaryCard totals={review.totals} batchCopies={review.batchCopies} />
    <NeedsADecision review={review} importing={importing} onChoose={onChoose} />
    <ImportBar
      review={review}
      writeFailure={writeFailure}
      importing={importing}
      settingsStatus={settingsStatus}
      choicesNotKept={choicesNotKept}
      onApplySettingsAgain={onApplySettingsAgain}
      onImport={onImport}
    />
    <DecidedAutomatically
      review={review}
      importing={importing}
      settings={settings}
      onChoose={onChoose}
      onReset={onReset}
      onApplySettings={onApplySettings}
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
