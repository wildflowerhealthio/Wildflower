import {
  FormatDecode,
  ImportedRecord,
  ImportPlan,
  ImportWrite,
  PlanTotals,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { type DateTime, Match, Option } from 'effect'
import { type JSX, useId } from 'react'

import {
  importButtonLabel,
  NO_RECORDS_READ_SENTENCE,
  NOTHING_TO_IMPORT_SENTENCE,
  readySentence,
  refusalMessagesOf,
  undecidedRecordLine,
  writeFailureMessage,
} from './plan-text.ts'
import * as RecordText from './record-text.ts'
import type { Review } from './use-import-plan-page.ts'
import type * as WriteFailure from './write-failure.ts'
import styles from './import-bar.module.css'

/** What {@link ImportBar} shows and does. */
interface ImportBarProps {
  readonly review: Review
  /** Why the last write did not end in an import, when one was sent. */
  readonly writeFailure: Option.Option<WriteFailure.Type>
  /** Whether the write is in flight. */
  readonly importing: boolean
  readonly onImport: () => void
}

/** The line naming the record under `key`, the first that has no choice. */
const undecidedLineOf = (
  plan: ImportPlan.Type,
  readAt: DateTime.DateTime,
  key: RecordKey.Type
): Option.Option<string> =>
  Option.map(ImportPlan.get(plan, key), ({ record }) =>
    undecidedRecordLine({
      resourceType: ImportedRecord.resourceTypeOf(record),
      title: RecordText.titleOf(readAt, record),
      fileTitle: FormatDecode.titleOf(ImportedRecord.originOf(record).pickedFiles),
    })
  )

/** Why the last write did not end in an import, above the bar. */
const WriteFailureAlert = ({ failure }: { readonly failure: WriteFailure.Type }): JSX.Element => (
  <div role="alert" className={styles['import-bar__failure']}>
    <p className={styles['import-bar__failure-message']}>{writeFailureMessage(failure)}</p>
    {Match.value(failure).pipe(
      Match.tag('Refused', ({ outcomes }) => (
        <ul className={styles['import-bar__failure-issues']}>
          {refusalMessagesOf(outcomes).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )),
      Match.tag('Unanswered', () => null),
      Match.exhaustive
    )}
  </div>
)

/** The Import button, described by the bar's sentence. */
const ImportButton = ({
  label,
  disabled,
  sentenceId,
  onImport,
}: {
  readonly label: string
  readonly disabled: boolean
  readonly sentenceId: string
  readonly onImport: () => void
}): JSX.Element => (
  <button
    type="button"
    className={`button-2 filled ${styles['import-bar__button']}`}
    disabled={disabled}
    aria-describedby={sentenceId}
    onClick={onImport}
  >
    {label}
  </button>
)

/**
 * The bar that writes the plan, stuck to the top of the page as it scrolls:
 * a sentence saying what the write does and the Import button, or, while a
 * record has no choice, a warning line naming it and the button disabled, or,
 * when nothing would be written, only the sentence saying so. Why the last
 * write did not end in an import is said above it.
 *
 * @remarks
 * Below 768px the bar's own box goes (`display: contents`), so the sentence
 * scrolls with the page above it and only the action's box sticks; the
 * warning line sits inside the action, so it stays with the button it
 * disables.
 */
const ImportBar = ({ review, writeFailure, importing, onImport }: ImportBarProps): JSX.Element => {
  const sentenceId = useId()
  const { overall } = review.totals
  const label = importButtonLabel(overall)
  const content = Match.value(review.write).pipe(
    Match.tag('Blocked', ({ undecided }) => (
      <div className={`${styles['import-bar__action']} ${styles['import-bar__action--blocked']}`}>
        {undecidedLineOf(review.plan, review.readAt, undecided[0]).pipe(
          Option.map((line) => (
            <p
              key="undecided"
              id={sentenceId}
              role="status"
              className={`${styles['import-bar__sentence']} ${styles['import-bar__sentence--blocked']}`}
            >
              {line}
            </p>
          )),
          Option.getOrNull
        )}
        <ImportButton label={label} disabled sentenceId={sentenceId} onImport={onImport} />
      </div>
    )),
    Match.tag('Ready', (ready) =>
      ImportWrite.isNothingToImport(ready) ? (
        <p role="status" className={styles['import-bar__sentence']}>
          {PlanTotals.recordsOf(overall) === 0
            ? NO_RECORDS_READ_SENTENCE
            : NOTHING_TO_IMPORT_SENTENCE}
        </p>
      ) : (
        <>
          <p id={sentenceId} role="status" className={styles['import-bar__sentence']}>
            {readySentence(overall)}
          </p>
          <div className={styles['import-bar__action']}>
            <ImportButton
              label={label}
              disabled={importing}
              sentenceId={sentenceId}
              onImport={onImport}
            />
          </div>
        </>
      )
    ),
    Match.exhaustive
  )
  return (
    <>
      {writeFailure.pipe(
        Option.map((failure) => <WriteFailureAlert key="failure" failure={failure} />),
        Option.getOrNull
      )}
      <div className={styles['import-bar']}>{content}</div>
    </>
  )
}

export { ImportBar }
export type { ImportBarProps }
