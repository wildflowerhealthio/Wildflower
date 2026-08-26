import type { ResourceWriteFailure } from 'fhir-r4/clients'
import type { ImportPreview } from 'importer-core'

/**
 * What a confirmed import wrote, and what it could not — the value the results
 * view reads and the `partial` decision folds over.
 *
 * @remarks
 * The write half (`importer-core`'s `ImportPreview.persist`) returns only the resources
 * it could not write, as data on a `never` error channel. That is the whole
 * failure record; everything the results view shows is derived from it and the
 * preview it wrote. `attempted` is the number of resources the preview held,
 * `failures` the ones the store rejected after their retries, and `written` the
 * difference — never re-counted off the wire, so a write that succeeded but whose
 * response the stub mangled cannot be mistaken for a failure. `sourceRef` is the
 * HAR-archive reference every written resource's `meta.source` points back to, so
 * the results view can name the provenance the confirm secured.
 *
 * @packageDocumentation
 */

/** The tally a confirmed import resolves with. */
interface ImportOutcome {
  /** How many resources the preview would write. */
  readonly attempted: number
  /** How many were written, i.e. `attempted` minus the failures. */
  readonly written: number
  /** The resources the store could not accept, verbatim from the write sink. */
  readonly failures: readonly ResourceWriteFailure[]
  /** The `DocumentReference/<id>` every written resource's `meta.source` names. */
  readonly sourceRef: string
}

/**
 * How many resources a preview would write, across every `resourceType`.
 *
 * @param preview - A claimed preview
 * @returns The flattened count of `resourcesByType`
 *
 * @remarks
 * The single source of "how many" both the confirm button's affordance and an
 * outcome's `attempted` read from, so the two can never disagree about whether a
 * preview has anything to write.
 */
const previewResourceCount = (preview: ImportPreview.Preview): number =>
  Object.values(preview.resourcesByType).reduce((total, list) => total + list.length, 0)

/**
 * Fold a preview and its write failures into an {@link ImportOutcome}.
 *
 * @param preview - The preview that was written
 * @param sourceRef - The archive reference stamped onto every written resource
 * @param failures - The write sink's failures, as data
 * @returns The tally, with `written` derived as `attempted - failures.length`
 */
const importOutcome = (
  preview: ImportPreview.Preview,
  sourceRef: string,
  failures: readonly ResourceWriteFailure[]
): ImportOutcome => {
  const attempted = previewResourceCount(preview)
  return { attempted, written: attempted - failures.length, failures, sourceRef }
}

/**
 * Whether an outcome is a partial import.
 *
 * @param outcome - A folded outcome
 * @returns `true` when any resource failed to write
 *
 * @remarks
 * The `collectImportSummary` semantics the live runner uses — **any** failure
 * makes the whole import `partial`, never a fraction or a threshold. A caller
 * maps this onto its terminal state so a single rejected write is surfaced rather
 * than swallowed by a mostly-successful run.
 */
const isPartialOutcome = (outcome: ImportOutcome): boolean => outcome.failures.length > 0

/**
 * Why a file in a batch contributed no written resources without that being a
 * failure.
 *
 * @remarks
 * The read half's two non-writing outcomes, plus the rare unreadable file: a
 * `no-source` file was recognized by nobody, a `nothing` file was recognized
 * but matched no resources, and an `unreadable` file did not parse as a HAR at
 * all. None is a failure — they are the multi-file echo of `NoSourceClaims`
 * being data, not an error — but each is reported so a reader knows why a file
 * they picked wrote nothing.
 */
type SkipReason = 'no-source' | 'nothing' | 'unreadable'

/**
 * What a single file in a confirmed batch resolved to.
 *
 * @remarks
 * Best-effort per the batch semantics: one file's failure never stops the rest,
 * so every file lands on exactly one of these. `imported` carries the file's own
 * {@link ImportOutcome} (which may itself be partial — some of its resources
 * failed to write); `uploadFailed` is the terminal case for a file whose archive
 * `DocumentReference` could not be uploaded, so none of its resources were
 * written and none could be stamped; `skipped` is a file that had nothing to
 * write. `fileName` names the file in every case, and `id` is the picked file's
 * stable identity, carried from its `ReadEntry` for a React `key` since two files
 * in a batch can share a name.
 */
type FileImportResult =
  | {
      readonly _tag: 'imported'
      readonly id: string
      readonly fileName: string
      readonly outcome: ImportOutcome
    }
  | {
      readonly _tag: 'uploadFailed'
      readonly id: string
      readonly fileName: string
      readonly error: unknown
    }
  | {
      readonly _tag: 'skipped'
      readonly id: string
      readonly fileName: string
      readonly reason: SkipReason
    }

/** A confirmed batch: one {@link FileImportResult} per file the user confirmed. */
type BatchOutcome = readonly FileImportResult[]

/** The aggregate tally a results view reads across a whole {@link BatchOutcome}. */
interface BatchSummary {
  /** Resources written across every file. */
  readonly written: number
  /** Resources attempted across every `imported` file. */
  readonly attempted: number
  /** Files whose archive uploaded and whose resources were persisted (whole or partial). */
  readonly importedFiles: number
  /** Every file the user confirmed, whatever its result. */
  readonly totalFiles: number
}

/**
 * Sum a {@link BatchOutcome} into its aggregate {@link BatchSummary}.
 *
 * @param batch - Every file's result
 * @returns The written/attempted totals and the file counts the summary row shows
 */
const summarizeBatch = (batch: BatchOutcome): BatchSummary =>
  batch.reduce<BatchSummary>(
    (summary, result) =>
      result._tag === 'imported'
        ? {
            written: summary.written + result.outcome.written,
            attempted: summary.attempted + result.outcome.attempted,
            importedFiles: summary.importedFiles + 1,
            totalFiles: summary.totalFiles + 1,
          }
        : { ...summary, totalFiles: summary.totalFiles + 1 },
    { written: 0, attempted: 0, importedFiles: 0, totalFiles: 0 }
  )

/**
 * Whether a confirmed batch is a partial import.
 *
 * @param batch - Every file's result
 * @returns `true` when any file's upload failed or any resource failed to write
 *
 * @remarks
 * The `collectImportSummary` semantics, lifted to the batch: **any** failure —
 * a file whose archive would not upload, or a single resource the store
 * rejected — makes the whole batch partial. A `skipped` file is not a failure
 * (it is the multi-file echo of `NoSourceClaims` being data), so it does not
 * make a batch partial on its own.
 */
const isPartialBatch = (batch: BatchOutcome): boolean =>
  batch.some(
    (result) =>
      result._tag === 'uploadFailed' ||
      (result._tag === 'imported' && isPartialOutcome(result.outcome))
  )

export {
  type BatchOutcome,
  type BatchSummary,
  type FileImportResult,
  type ImportOutcome,
  importOutcome,
  isPartialBatch,
  isPartialOutcome,
  previewResourceCount,
  type SkipReason,
  summarizeBatch,
}
