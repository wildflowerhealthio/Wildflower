import type { JSX } from 'react'

import {
  type BatchOutcome,
  groupResultsByStatus,
  isPartialBatch,
  type ResourceResult,
  type SkipReason,
  skips,
  type StatusGroup,
  summarizeBatch,
  type WriteIssue,
} from './import-outcome.ts'
import styles from './import-results.module.css'

/**
 * The results view: what a confirmed batch wrote, what it could not, and why —
 * every submitted resource grouped by the response code the server returned,
 * in foldable sections that open to the full diagnostics.
 *
 * @remarks
 * The write half (`persistBatchBundle`) reports each entry's echoed status and
 * any OperationOutcome diagnostics, so this view groups every file's resources
 * across the whole batch by status (failures first, then ascending code):
 * successes fold away, failures open to the server's own messages. Files that
 * had nothing to write are reported in their own section. A partial import is a
 * first-class outcome, not a failure banner: any rejected resource (the
 * source file included, since it writes in the same batch) frames the
 * batch as partial, while everything that wrote is already on the device.
 *
 * @packageDocumentation
 */

/** Props for {@link ImportResults}. */
interface ImportResultsProps {
  /** Every file's result from the confirmed batch. */
  readonly batch: BatchOutcome
  /** Called to discard the results and return to the source picker. */
  readonly onStartOver: () => void
}

/** Heading when every file's resources wrote. */
const COMPLETE_HEADING = 'Import complete'

/** Heading when at least one resource write failed. */
const PARTIAL_HEADING = 'Imported with some failures'

/** Heading for the section listing files that had nothing to write. */
const SKIPPED_HEADING = 'Files with nothing to import'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** Why a skipped file wrote nothing, in words a reader can act on. */
const skipReasonText = (reason: SkipReason): string => {
  if (reason === 'nothing') return 'Nothing here to import.'
  return 'Could not be read.'
}

/** One resource's `Type/id` identity, as the server addressed it. */
const targetLabel = (result: ResourceResult): string => `${result.target.label}/${result.target.id}`

/** One server issue's line: its severity/code and the message. */
const IssueLine = ({ issue }: { readonly issue: WriteIssue }): JSX.Element => (
  <li className={styles.issue}>
    <span className={styles.issueCode}>
      {issue.severity}
      {issue.code === '' ? '' : ` · ${issue.code}`}
    </span>
    {issue.text !== '' && <span className={styles.issueText}>{issue.text}</span>}
  </li>
)

/** One resource's row within a status group: its `Type/id`, its file, and any diagnostics. */
const ResultRow = ({ result }: { readonly result: ResourceResult }): JSX.Element => (
  <li className={styles.resultRow}>
    <span className={styles.target}>{targetLabel(result)}</span>
    <span className={styles.fileName}>{result.title}</span>
    {result.issues.length > 0 && (
      <ul className={styles.issueList}>
        {result.issues.map((issue) => (
          <IssueLine key={`${issue.severity}:${issue.code}:${issue.text}`} issue={issue} />
        ))}
      </ul>
    )}
  </li>
)

/**
 * One status group as a foldable section: its status and count in the summary,
 * open by default when it is a failure so its diagnostics show without a click,
 * folded away when it succeeded.
 */
const StatusSection = ({ group }: { readonly group: StatusGroup }): JSX.Element => (
  <details
    className={styles.statusSection}
    open={!group.ok}
    data-status-ok={group.ok}
    role={group.ok ? undefined : 'alert'}
  >
    <summary className={styles.statusSummary} data-diff-status={group.ok ? 'ok' : 'failed'}>
      {group.status} · {group.results.length} {plural(group.results.length, 'resource')}
    </summary>
    <ul className={styles.resultList}>
      {group.results.map((result) => (
        // Two units can write the same Type/id (shared content across a batch),
        // so the target alone is not unique within a group — pair it with the
        // unit's title.
        <ResultRow key={`${result.title}:${targetLabel(result)}`} result={result} />
      ))}
    </ul>
  </details>
)

/**
 * The results surface. Reads the {@link BatchOutcome}, frames it as a complete
 * or partial import, and lists every resource grouped by response code, then
 * the files that had nothing to write.
 */
const ImportResults = ({ batch, onStartOver }: ImportResultsProps): JSX.Element => {
  const partial = isPartialBatch(batch)
  const summary = summarizeBatch(batch)
  const groups = groupResultsByStatus(batch)
  const skipped = skips(batch)
  return (
    <section aria-label="Import results" className={styles.results}>
      <h2 className={styles.heading}>{partial ? PARTIAL_HEADING : COMPLETE_HEADING}</h2>
      <p role="status" className={styles.summary}>
        Wrote {summary.written} of {summary.attempted} {plural(summary.attempted, 'resource')}
        {summary.excluded > 0 ? ` (${summary.excluded} excluded)` : ''} across{' '}
        {summary.importedFiles} of {summary.totalFiles} {plural(summary.totalFiles, 'file')}.
      </p>

      {groups.length > 0 && (
        <div className={styles.groups}>
          {groups.map((group) => (
            <StatusSection key={group.status} group={group} />
          ))}
        </div>
      )}

      {skipped.length > 0 && (
        <section className={styles.subsection} aria-label={SKIPPED_HEADING}>
          <h3 className={styles.subheading}>{SKIPPED_HEADING}</h3>
          <ul className={styles.fileList}>
            {skipped.map((file) => (
              <li key={file.id} className={styles.fileRow}>
                <span className={styles.fileName}>{file.title}</span>
                <span className={styles.fileNote}>{skipReasonText(file.reason)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.startOver} onClick={onStartOver}>
          Import another archive
        </button>
      </div>
    </section>
  )
}

export {
  COMPLETE_HEADING,
  ImportResults,
  type ImportResultsProps,
  PARTIAL_HEADING,
  SKIPPED_HEADING,
}
