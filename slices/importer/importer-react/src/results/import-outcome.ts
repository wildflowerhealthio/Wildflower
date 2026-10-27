import {
  type BatchEntryOutcome,
  groupByStatus,
  type WriteIssue,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { SkipReason } from '@wildflowerhealthio/importer-core'

/**
 * What a confirmed import wrote, and what it could not — the value the results
 * view reads and the `partial` decision folds over.
 *
 * @remarks
 * The write half (`persistTransactionBundle`) reports the **whole** per-entry
 * outcome — every submitted resource's echoed HTTP status and any server
 * diagnostics, success or failure — not just failures. The results view groups
 * those across the batch by status code, so `written` is the count of entries
 * whose status succeeded, derived from the results rather than re-counted off
 * the wire. The batch is one transaction, so its entries land together or not
 * at all: a refusal reaches here as every entry failed under the one cause.
 *
 * @packageDocumentation
 */

/**
 * One submitted resource's outcome, tagged with the unit it belongs to — a
 * {@link BatchEntryOutcome} lifted to batch scope so the results view can
 * group every unit's resources together by status while still naming each
 * row's unit.
 */
interface ResourceResult extends BatchEntryOutcome {
  /** The title of the unit this resource was written from: its file name for a single-file format, the linked records' heading for one of them. */
  readonly title: string
}

/** The tally a confirmed, written unit resolves with. */
interface ImportOutcome {
  /** How many resources the confirmed review chose to write. */
  readonly attempted: number
  /**
   * How many previewed resources the reviewer opted out before confirm —
   * reported for symmetry with `attempted`.
   */
  readonly excluded: number
  /** One result per attempted resource, in submit order — successes and failures alike. */
  readonly results: readonly ResourceResult[]
}

/**
 * Fold a unit's attempted write into an {@link ImportOutcome}, tagging each
 * per-entry outcome with the unit's title.
 *
 * @param attempted - How many resources the confirm attempted to write
 * @param title - The unit the resources were decoded from
 * @param entries - The write sink's per-entry outcomes, in submit order
 * @param excluded - How many previewed resources the reviewer opted out (default 0)
 * @returns The tally, with `results` carrying every entry's status + diagnostics
 */
const importOutcome = (
  attempted: number,
  title: string,
  entries: readonly BatchEntryOutcome[],
  excluded = 0
): ImportOutcome => ({
  attempted,
  excluded,
  results: entries.map((entry) => ({ ...entry, title })),
})

/** How many of a file's resources the server accepted (a 2xx status). */
const writtenCount = (outcome: ImportOutcome): number =>
  outcome.results.filter((result) => result.ok).length

/**
 * Whether an outcome is a partial import.
 *
 * @param outcome - A folded outcome
 * @returns `true` when any resource failed to write
 */
const isPartialOutcome = (outcome: ImportOutcome): boolean =>
  outcome.results.some((result) => !result.ok)

/**
 * What a single unit in a confirmed batch resolved to.
 *
 * @remarks
 * Every unit lands on exactly one of these. `imported` carries the unit's own
 * {@link ImportOutcome} (whose resources failed together with the rest of
 * the transaction, or landed together with them); `skipped` is a
 * unit that had nothing to write, with `importer-core`'s {@link SkipReason}.
 * The source file writes in the same bundle as the resources it names, so
 * its write is just one of the `imported` unit's per-entry results. `title`
 * names the unit in every case (its file name, for a single-file format),
 * and `id` is the unit's stable identity, carried from its `FormatDecode.Result`
 * for a React `key` since two units in a batch can share a title.
 */
type FileImportResult =
  | {
      readonly _tag: 'imported'
      readonly id: string
      readonly title: string
      readonly outcome: ImportOutcome
    }
  | {
      readonly _tag: 'skipped'
      readonly id: string
      readonly title: string
      readonly reason: SkipReason | 'unrecognized'
    }

/**
 * A confirmed batch: one {@link FileImportResult} per unit the user
 * confirmed, and the outcome of each linked record, which is no file's.
 */
interface BatchOutcome {
  readonly files: readonly FileImportResult[]
  /** One result per linked record the batch wrote, in submit order. */
  readonly linked: readonly ResourceResult[]
}

/** Every written-or-attempted resource across the batch: the linked records, then the imported files'. */
const allResults = (batch: BatchOutcome): readonly ResourceResult[] => [
  ...batch.linked,
  ...batch.files.flatMap((result) => (result._tag === 'imported' ? result.outcome.results : [])),
]

/** Every file the reviewer confirmed that had nothing to write. */
const skips = (
  batch: BatchOutcome
): readonly Extract<FileImportResult, { readonly _tag: 'skipped' }>[] =>
  batch.files.filter((result) => result._tag === 'skipped')

/** One response status across the batch, with the resources that resolved to it. */
interface StatusGroup {
  /** The echoed status (`"201 Created"`, `"422 Unprocessable Entity"`, `"No response"`). */
  readonly status: string
  /** Whether this status is a success (a 2xx). */
  readonly ok: boolean
  /** The resources that resolved to this status, across every file, in encounter order. */
  readonly results: readonly ResourceResult[]
}

/**
 * Group every resource across the batch by its response status, in
 * `fhir-r4`'s `groupByStatus` order: failures first, then by ascending HTTP
 * code (a status with no numeric code sorts last within its success/failure
 * band).
 *
 * @param batch - Every file's result
 * @returns One {@link StatusGroup} per distinct status, sorted for display
 */
const groupResultsByStatus = (batch: BatchOutcome): readonly StatusGroup[] =>
  groupByStatus(allResults(batch)).map(({ status, ok, outcomes }) => ({
    status,
    ok,
    results: outcomes,
  }))

/** The aggregate tally a results view reads across a whole {@link BatchOutcome}. */
interface BatchSummary {
  /** Resources written (2xx) across every file and the linked records. */
  readonly written: number
  /** Resources attempted across every `imported` file and the linked records. */
  readonly attempted: number
  /** Previewed resources the reviewer opted out before confirm, across every file. */
  readonly excluded: number
  /** Files whose resources were persisted (whole or partial). */
  readonly importedFiles: number
  /** Every file the user confirmed, whatever its result. */
  readonly totalFiles: number
}

/**
 * Sum a {@link BatchOutcome} into its aggregate {@link BatchSummary}.
 *
 * @param batch - Every file's result
 * @returns The written/attempted/excluded totals and the file counts the
 *   summary row shows; a linked record counts as a resource, not a file
 */
const summarizeBatch = (batch: BatchOutcome): BatchSummary =>
  batch.files.reduce<BatchSummary>(
    (summary, result) =>
      result._tag === 'imported'
        ? {
            written: summary.written + writtenCount(result.outcome),
            attempted: summary.attempted + result.outcome.attempted,
            excluded: summary.excluded + result.outcome.excluded,
            importedFiles: summary.importedFiles + 1,
            totalFiles: summary.totalFiles + 1,
          }
        : { ...summary, totalFiles: summary.totalFiles + 1 },
    {
      written: batch.linked.filter((result) => result.ok).length,
      attempted: batch.linked.length,
      excluded: 0,
      importedFiles: 0,
      totalFiles: 0,
    }
  )

/**
 * Whether a confirmed batch is a partial import.
 *
 * @param batch - Every file's result
 * @returns `true` when any resource failed to write
 *
 * @remarks
 * The `collectImportSummary` semantics, lifted to the batch: **any** rejected
 * resource — the source file and the linked records included, since they
 * write in the same transaction — makes the whole batch partial. A `skipped`
 * file is not a failure (an empty preview is ordinary data), so it does not
 * make a batch partial on its own.
 */
const isPartialBatch = (batch: BatchOutcome): boolean =>
  batch.linked.some((result) => !result.ok) ||
  batch.files.some((result) => result._tag === 'imported' && isPartialOutcome(result.outcome))

export {
  allResults,
  type BatchOutcome,
  type BatchSummary,
  type FileImportResult,
  groupResultsByStatus,
  type ImportOutcome,
  importOutcome,
  isPartialBatch,
  isPartialOutcome,
  type ResourceResult,
  type SkipReason,
  skips,
  type StatusGroup,
  summarizeBatch,
  writtenCount,
  type WriteIssue,
}
