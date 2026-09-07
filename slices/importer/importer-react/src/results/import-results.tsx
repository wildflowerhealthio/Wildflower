import { Cause, ParseResult, Runtime } from 'effect'
import type { JSX } from 'react'

import type { PersistFailure } from 'importer-fundamentals'

import {
  type BatchOutcome,
  type FileImportResult,
  isPartialBatch,
  type SkipReason,
  summarizeBatch,
} from './import-outcome.ts'
import styles from './import-results.module.css'

/**
 * The results view: what a confirmed batch wrote, what it could not, and, per
 * file, the archive every written resource now points back to.
 *
 * @remarks
 * A partial import is a first-class outcome, not a failure banner. Best-effort
 * across the batch means each file lands on its own result — imported (whole or
 * partial), upload-failed, or skipped for having nothing to write — and the
 * `collectImportSummary` semantics decide the framing: **any** file whose upload
 * failed or whose resources partly failed makes the whole batch `partial`, while
 * the files that did write are already on the device. Failed resources and failed
 * uploads accumulate against their file rather than collapsing to a count.
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

/** Heading when at least one file's upload or resource write failed. */
const PARTIAL_HEADING = 'Imported with some failures'

/** The failed-resource identity a row shows — the write sink's own `label`/`id`. */
const failureLabel = (failure: PersistFailure): string =>
  `${failure.failed.label}/${failure.failed.id}`

/**
 * The readable cause of a file whose archive upload failed.
 *
 * @remarks
 * The confirm step already unwraps the upload's `FiberFailure` back to the typed
 * error the FHIR client raised (`Cause.squash`); this formats that error for the
 * row and unwraps once more defensively. A `ParseError` — a response body the
 * client could not decode against its schema — is rendered as its full field
 * tree (`TreeFormatter`) rather than a one-line "Decode error", so a schema
 * mismatch names the offending path. Any other error (a `ResponseError` for an
 * unexpected status, say — its message already names the method, URL, and status)
 * shows its `message`; a non-`Error` is stringified rather than dropped.
 */
const causeOf = (error: unknown): string => {
  const unwrapped = Runtime.isFiberFailure(error)
    ? Cause.squash(error[Runtime.FiberFailureCauseId])
    : error
  if (ParseResult.isParseError(unwrapped)) {
    return ParseResult.TreeFormatter.formatErrorSync(unwrapped)
  }
  return unwrapped instanceof Error ? unwrapped.message : String(unwrapped)
}

/** Why a skipped file wrote nothing, in words a reader can act on. */
const skipReasonText = (reason: SkipReason): string => {
  if (reason === 'nothing') return 'Nothing here to import.'
  return 'Could not be read as a HAR.'
}

/** One file's row: its name and whatever it resolved to. */
const FileResultRow = ({ result }: { readonly result: FileImportResult }): JSX.Element => {
  if (result._tag === 'skipped') {
    return (
      <li className={styles.fileRow}>
        <span className={styles.fileName}>{result.fileName}</span>
        <span className={styles.fileNote}>{skipReasonText(result.reason)}</span>
      </li>
    )
  }
  if (result._tag === 'uploadFailed') {
    return (
      <li className={styles.fileRow}>
        <span className={styles.fileName}>{result.fileName}</span>
        <span role="alert" className={styles.fileError}>
          Its archive could not be uploaded, so none of its resources were written.
        </span>
        <pre className={styles.detail}>{causeOf(result.error)}</pre>
      </li>
    )
  }
  const { outcome } = result
  return (
    <li className={styles.fileRow}>
      <span className={styles.fileName}>{result.fileName}</span>
      <span className={styles.fileNote}>
        Wrote {outcome.written} of {outcome.attempted}{' '}
        {outcome.attempted === 1 ? 'resource' : 'resources'}
        {outcome.excluded > 0 ? ` · ${outcome.excluded} excluded` : ''} · provenance{' '}
        <span className={styles.sourceRef}>{outcome.sourceRef}</span>
      </span>
      {outcome.failures.length > 0 && (
        <div role="alert" className={styles.failures}>
          <p className={styles.failuresHeading}>
            {outcome.failures.length} {outcome.failures.length === 1 ? 'resource' : 'resources'}{' '}
            could not be written:
          </p>
          <ul className={styles.failureList}>
            {outcome.failures.map((failure) => (
              <li key={failureLabel(failure)} className={styles.failureRow}>
                {failureLabel(failure)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

/**
 * The results surface. Reads the {@link BatchOutcome}, frames it as a complete or
 * partial import, and lists every file's result — writes, failed uploads, and
 * skips alike.
 */
const ImportResults = ({ batch, onStartOver }: ImportResultsProps): JSX.Element => {
  const partial = isPartialBatch(batch)
  const summary = summarizeBatch(batch)
  return (
    <section aria-label="Import results" className={styles.results}>
      <h2 className={styles.heading}>{partial ? PARTIAL_HEADING : COMPLETE_HEADING}</h2>
      <p role="status" className={styles.summary}>
        Wrote {summary.written} of {summary.attempted}{' '}
        {summary.attempted === 1 ? 'resource' : 'resources'}
        {summary.excluded > 0 ? ` (${summary.excluded} excluded)` : ''} across{' '}
        {summary.importedFiles} of {summary.totalFiles}{' '}
        {summary.totalFiles === 1 ? 'file' : 'files'}.
      </p>
      <ul className={styles.fileList}>
        {batch.map((result) => (
          <FileResultRow key={result.id} result={result} />
        ))}
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.startOver} onClick={onStartOver}>
          Import another archive
        </button>
      </div>
    </section>
  )
}

export { COMPLETE_HEADING, ImportResults, type ImportResultsProps, PARTIAL_HEADING }
