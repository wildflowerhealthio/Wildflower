import {
  ImportedRecord,
  ImportPlan,
  ImportWrite,
  PlanTotals,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { prefersReducedMotion } from '@wildflowerhealthio/react-kitchen-sink'
import { LinkButton, Notice } from '@wildflowerhealthio/react-tundraish'
import { type DateTime, Match, Option } from 'effect'
import { type JSX, useId } from 'react'

import type { FormatKind } from '@wildflowerhealthio/importer-core'

import { formatRegistry } from '../registry.ts'
import { decisionCardDomIdOf } from './decision-card-ids.ts'
import {
  GO_TO_RECORD_LABEL,
  importButtonLabel,
  NO_RECORDS_READ_SENTENCE,
  NOTHING_TO_IMPORT_SENTENCE,
  readySentence,
  refusalMessagesOf,
  REREADING_MESSAGE,
  settingsNotAppliedMessage,
  TRY_AGAIN_LABEL,
  choicesNotKeptLine,
  undecidedRecordLine,
  writeFailureMessage,
} from './plan-text.ts'
import * as RecordText from './record-text.ts'
import type { Review, SettingsStatus } from './use-import-plan-page.ts'
import type * as WriteFailure from './write-failure.ts'
import styles from './import-bar.module.css'

/** What {@link ImportBar} shows and does. */
interface ImportBarProps {
  readonly review: Review
  /** Why the last write did not end in an import, when one was sent. */
  readonly writeFailure: Option.Option<WriteFailure.Type>
  /** Whether the write is in flight. */
  readonly importing: boolean
  /**
   * Whether the plan shown was read under the reviewer's settings: while it
   * is read again Import waits, and settings not applied are said above it.
   */
  readonly settingsStatus: SettingsStatus
  /** How many of the reviewer's choices the last read again could not keep, said above it. */
  readonly choicesNotKept: number
  /** Read again every format whose settings were not applied. */
  readonly onApplySettingsAgain: () => void
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
      fileTitle: RecordText.fileTitleOf(record),
    })
  )

/**
 * "Go to record": scrolls the card of the record under `recordKey` into
 * view, smoothly unless the reader asked for reduced motion, and focuses its
 * first radio without a second scroll.
 */
const GoToRecordButton = ({
  plan,
  recordKey,
}: {
  readonly plan: ImportPlan.Type
  readonly recordKey: RecordKey.Type
}): JSX.Element => {
  const handleClick = (): void => {
    const card = Option.flatMapNullable(decisionCardDomIdOf(plan, recordKey), (domId) =>
      document.getElementById(domId)
    )
    if (Option.isNone(card)) return
    card.value.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    })
    card.value
      .querySelector<HTMLInputElement>('input[type="radio"]')
      ?.focus({ preventScroll: true })
  }
  return (
    <LinkButton className={styles['import-bar__go-to-record']} onClick={handleClick}>
      {GO_TO_RECORD_LABEL}
    </LinkButton>
  )
}

/** The formats whose settings were not applied to the plan shown, when there are any. */
const notAppliedFormatsOf = (
  settingsStatus: SettingsStatus
): Option.Option<readonly FormatKind[]> =>
  settingsStatus._tag === 'NotApplied' ? Option.some(settingsStatus.formats) : Option.none()

/** Why the last write did not end in an import, above the bar, with each distinct refusal. */
const WriteFailureNotice = ({ failure }: { readonly failure: WriteFailure.Type }): JSX.Element => {
  const issues = Match.value(failure).pipe(
    Match.tag('Refused', ({ outcomes }) => (
      <ul className={styles['import-bar__issues']}>
        {refusalMessagesOf(outcomes).map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    )),
    Match.tag('Unanswered', () => undefined),
    Match.exhaustive
  )
  return (
    <Notice tone="danger" details={issues}>
      {writeFailureMessage(failure)}
    </Notice>
  )
}

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
 * record has no choice, a warning line naming it, a way to go to its card
 * and the button disabled, or,
 * when nothing would be written, only the sentence saying so. While the
 * files are read again under changed settings the sentence says so and the
 * button is disabled. Above it, full width: why the last write did not end
 * in an import; settings that were not applied, by format, in a danger
 * `Notice` whose Try again reads those formats again; and, as a plain line,
 * how many choices the last read again could not keep.
 *
 * @remarks
 * Below 768px the bar's own box goes (`display: contents`), so the sentence
 * scrolls with the page above it and only the action's box sticks; the
 * warning line sits inside the action, so it stays with the button it
 * disables.
 */
const ImportBar = ({
  review,
  writeFailure,
  importing,
  settingsStatus,
  choicesNotKept,
  onApplySettingsAgain,
  onImport,
}: ImportBarProps): JSX.Element => {
  const rereading = settingsStatus._tag === 'Rereading'
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
        <GoToRecordButton plan={review.plan} recordKey={undecided[0]} />
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
            {rereading ? REREADING_MESSAGE : readySentence(overall)}
          </p>
          <div className={styles['import-bar__action']}>
            <ImportButton
              label={label}
              disabled={importing || rereading}
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
        Option.map((failure) => <WriteFailureNotice key="failure" failure={failure} />),
        Option.getOrNull
      )}
      {notAppliedFormatsOf(settingsStatus).pipe(
        Option.map((formats) => (
          <Notice
            key="settings-not-applied"
            tone="danger"
            action={{ label: TRY_AGAIN_LABEL, onClick: onApplySettingsAgain }}
          >
            {settingsNotAppliedMessage(
              formats.map((format) => formatRegistry[format].display.title)
            )}
          </Notice>
        )),
        Option.getOrNull
      )}
      {choicesNotKept === 0 ? null : (
        <p className={styles['import-bar__not-kept']}>{choicesNotKeptLine(choicesNotKept)}</p>
      )}
      <div className={styles['import-bar']}>{content}</div>
    </>
  )
}

export { ImportBar }
export type { ImportBarProps }
