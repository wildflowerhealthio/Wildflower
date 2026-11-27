import type { BatchCopies } from '@wildflowerhealthio/importer-core'
import { FormatDecode, PlanTotals } from '@wildflowerhealthio/importer-fundamentals'
import { Number as Num } from 'effect'
import type { JSX } from 'react'

import {
  CountLabel,
  fileSetLine,
  IMPORT_PLAN_KICKER,
  NOT_RECOGNISED_LINE,
  openLine,
  summaryTitle,
  UNREADABLE_LINE,
} from './plan-text.ts'
import styles from './summary-card.module.css'

/** What {@link SummaryCard} shows. */
interface SummaryCardProps {
  /** The plan's counts, overall and per file set. */
  readonly totals: PlanTotals.Type
  /** The picked files as read, for the files no record came from. */
  readonly batchCopies: BatchCopies
}

/**
 * How many files were picked: those of every file set a record came from,
 * every file that could not be read, and every file no format recognised.
 */
const pickedFilesIn = (totals: PlanTotals.Type, batchCopies: BatchCopies): number =>
  Num.sumAll([
    ...totals.fileSets.map(({ origin }) => origin.pickedFiles.length),
    ...batchCopies.formats.map(({ unreadableFiles }) => unreadableFiles.length),
    batchCopies.unrecognizedFiles.length,
  ])

/** One of the card's four counts: its label and its number, shown number first. */
const Count = ({
  label,
  count,
}: {
  readonly label: string
  readonly count: number
}): JSX.Element => (
  <div className={styles['summary-card__count']}>
    <dt className={styles['summary-card__label']}>{label}</dt>
    <dd className={styles['summary-card__number']}>{count}</dd>
  </div>
)

/** One file's line: its title and what became of it, in red when nothing could be read from it. */
const FileLine = ({
  title,
  line,
  failed,
}: {
  readonly title: string
  readonly line: string
  readonly failed: boolean
}): JSX.Element => (
  <li
    className={
      failed
        ? `${styles['summary-card__file']} ${styles['summary-card__file--failed']}`
        : styles['summary-card__file']
    }
  >
    <span className={styles['summary-card__file-title']}>{title}</span>
    <span className={styles['summary-card__file-line']}>{line}</span>
  </li>
)

/**
 * The top of the import plan: how many records from how many files, what the
 * plan does with them (Create, Update, Link to existing, Needs a decision),
 * and one line per file set, then one per picked file nothing was read from.
 */
const SummaryCard = ({ totals, batchCopies }: SummaryCardProps): JSX.Element => {
  const { overall } = totals
  const open = overall.byLabel.Open
  const files = pickedFilesIn(totals, batchCopies)
  return (
    <section aria-label="Summary" className={styles['summary-card']}>
      <div className={styles['summary-card__heading']}>
        <span className={styles['summary-card__kicker']}>{IMPORT_PLAN_KICKER}</span>
        <h2 className={styles['summary-card__title']}>
          {summaryTitle(PlanTotals.recordsOf(overall), files)}
        </h2>
      </div>
      <dl className={styles['summary-card__counts']}>
        <Count label={CountLabel.Create} count={overall.byLabel.Create} />
        <Count label={CountLabel.Update} count={overall.byLabel.Update} />
        <Count label={CountLabel.LinkToExisting} count={overall.byLabel.LinkToExisting} />
        <div
          className={
            open === 0
              ? styles['summary-card__count']
              : `${styles['summary-card__count']} ${styles['summary-card__count--open']}`
          }
        >
          <dt className={styles['summary-card__label']}>{CountLabel.NeedsDecision}</dt>
          <dd className={styles['summary-card__number']}>{overall.needsDecision}</dd>
          {open === 0 ? null : <dd className={styles['summary-card__open']}>{openLine(open)}</dd>}
        </div>
      </dl>
      <ul className={styles['summary-card__files']}>
        {totals.fileSets.map(({ origin, counts }) => (
          <FileLine
            key={FormatDecode.makeId(origin.format, origin.pickedFiles)}
            title={FormatDecode.titleOf(origin.pickedFiles)}
            line={fileSetLine(counts)}
            failed={false}
          />
        ))}
        {batchCopies.formats.flatMap(({ unreadableFiles }) =>
          unreadableFiles.map((file) => (
            <FileLine key={file.id} title={file.title} line={UNREADABLE_LINE} failed />
          ))
        )}
        {batchCopies.unrecognizedFiles.map((file) => (
          <FileLine key={file.id} title={file.title} line={NOT_RECOGNISED_LINE} failed />
        ))}
      </ul>
    </section>
  )
}

export { SummaryCard }
export type { SummaryCardProps }
