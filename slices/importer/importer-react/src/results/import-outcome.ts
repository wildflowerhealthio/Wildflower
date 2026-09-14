import type { BatchEntryOutcome, WriteIssue } from 'fhir-r4/clients'

/**
 * What a confirmed import wrote, and what it could not — the value the results
 * view reads and the `partial` decision folds over.
 *
 * @remarks
 * The write half (`persistBatchBundle`) now reports the **whole** per-entry
 * outcome — every submitted resource's echoed HTTP status and any server
 * diagnostics, success or failure — not just failures. The results view groups
 * those across the batch by status code, so `written` is the count of entries
 * whose status succeeded, derived from the results rather than re-counted off
 * the wire.
 *
 * @packageDocumentation
 */

/**
 * One submitted resource's outcome, tagged with the file and provenance it
 * belongs to — a {@link BatchEntryOutcome} lifted to batch scope so the
 * results view can group every file's resources together by status while still
 * naming each row's file and the archive it wrote against.
 */
interface ResourceResult extends BatchEntryOutcome {
  /** The file this resource was decoded from. */
  readonly fileName: string
  /**
   * The `DocumentReference/<id>` its `meta.source` names, or `undefined` when
   * the reviewer skipped this file's source-file archive so nothing was
   * stamped onto its extracted resources.
   */
  readonly sourceRef: string | undefined
}

/** The tally a confirmed, written file resolves with. */
interface ImportOutcome {
  /** How many resources the confirmed review chose to write. */
  readonly attempted: number
  /**
   * How many previewed resources the reviewer opted out before confirm —
   * reported for symmetry with `attempted`.
   */
  readonly excluded: number
  /**
   * The `DocumentReference/<id>` every extracted resource's `meta.source`
   * names, or `undefined` when the source-file archive was skipped so nothing
   * was stamped.
   */
  readonly sourceRef: string | undefined
  /** One result per attempted resource, in submit order — successes and failures alike. */
  readonly results: readonly ResourceResult[]
}

/**
 * Fold a file's attempted write into an {@link ImportOutcome}, tagging each
 * per-entry outcome with the file name and provenance ref.
 *
 * @param attempted - How many resources the confirm attempted to write
 * @param sourceRef - The archive reference stamped onto every extracted
 *   resource, or `undefined` when the archive was skipped
 * @param fileName - The file the resources were decoded from
 * @param entries - The write sink's per-entry outcomes, in submit order
 * @param excluded - How many previewed resources the reviewer opted out (default 0)
 * @returns The tally, with `results` carrying every entry's status + diagnostics
 */
const importOutcome = (
  attempted: number,
  sourceRef: string | undefined,
  fileName: string,
  entries: readonly BatchEntryOutcome[],
  excluded = 0
): ImportOutcome => ({
  attempted,
  excluded,
  sourceRef,
  results: entries.map((entry) => ({ ...entry, fileName, sourceRef })),
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
 * Why a file in a batch contributed no written resources without that being a
 * failure.
 *
 * @remarks
 * The read half's non-writing outcome, plus the rare unreadable file: a
 * `nothing` file previewed no resources to import (its traffic matched no kind,
 * or matched but decoded nothing — one collapsed outcome under per-URL
 * recognition), and an `unreadable` file did not parse as a HAR at all. Neither
 * is a failure — an empty preview is ordinary data, not an error — but each is
 * reported so a reader knows why a file they picked wrote nothing.
 */
type SkipReason = 'nothing' | 'unreadable'

/**
 * What a single file in a confirmed batch resolved to.
 *
 * @remarks
 * Best-effort per the batch semantics: one file's failure never stops the rest,
 * so every file lands on exactly one of these. `imported` carries the file's own
 * {@link ImportOutcome} (which may itself be partial — some of its resources,
 * the source-file archive among them, failed to write); `skipped` is a file
 * that had nothing to write. There is no `uploadFailed` case: the archive is
 * no longer uploaded on its own, so its write is just one of the `imported`
 * file's per-entry results. `fileName` names the file in every case, and `id`
 * is the picked file's stable identity, carried from its `FileReadOutcome` for
 * a React `key` since two files in a batch can share a name.
 */
type FileImportResult =
  | {
      readonly _tag: 'imported'
      readonly id: string
      readonly fileName: string
      readonly outcome: ImportOutcome
    }
  | {
      readonly _tag: 'skipped'
      readonly id: string
      readonly fileName: string
      readonly reason: SkipReason
    }

/** A confirmed batch: one {@link FileImportResult} per file the user confirmed. */
type BatchOutcome = readonly FileImportResult[]

/** Every written-or-attempted resource across the batch, flattened out of the imported files. */
const allResults = (batch: BatchOutcome): readonly ResourceResult[] =>
  batch.flatMap((result) => (result._tag === 'imported' ? result.outcome.results : []))

/** Every file the reviewer confirmed that had nothing to write. */
const skips = (
  batch: BatchOutcome
): readonly Extract<FileImportResult, { readonly _tag: 'skipped' }>[] =>
  batch.filter((result) => result._tag === 'skipped')

/** One response status across the batch, with the resources that resolved to it. */
interface StatusGroup {
  /** The echoed status (`"201 Created"`, `"422 Unprocessable Entity"`, `"No response"`). */
  readonly status: string
  /** Whether this status is a success (a 2xx). */
  readonly ok: boolean
  /** The resources that resolved to this status, across every file, in encounter order. */
  readonly results: readonly ResourceResult[]
}

/** The leading numeric HTTP code of a status string, or `NaN` when it has none. */
const statusCode = (status: string): number => Number.parseInt(status, 10)

/**
 * Group every resource across the batch by its response status, failures
 * first, then by ascending HTTP code (a status with no numeric code sorts
 * last within its success/failure band).
 *
 * @param batch - Every file's result
 * @returns One {@link StatusGroup} per distinct status, sorted for display
 */
const groupResultsByStatus = (batch: BatchOutcome): readonly StatusGroup[] => {
  const groups = new Map<string, ResourceResult[]>()
  for (const result of allResults(batch)) {
    const bucket = groups.get(result.status)
    if (bucket === undefined) groups.set(result.status, [result])
    else bucket.push(result)
  }
  return [...groups.entries()]
    .map(([status, results]): StatusGroup => ({ status, ok: results[0]?.ok ?? true, results }))
    .toSorted((a, b) => {
      // Failures before successes.
      if (a.ok !== b.ok) return a.ok ? 1 : -1
      const codeA = statusCode(a.status)
      const codeB = statusCode(b.status)
      // A numeric code sorts ascending; a code-less status (the sentinel) sorts last.
      if (Number.isNaN(codeA)) return Number.isNaN(codeB) ? 0 : 1
      if (Number.isNaN(codeB)) return -1
      return codeA - codeB
    })
}

/** The aggregate tally a results view reads across a whole {@link BatchOutcome}. */
interface BatchSummary {
  /** Resources written (2xx) across every file. */
  readonly written: number
  /** Resources attempted across every `imported` file. */
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
 *   summary row shows
 */
const summarizeBatch = (batch: BatchOutcome): BatchSummary =>
  batch.reduce<BatchSummary>(
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
    { written: 0, attempted: 0, excluded: 0, importedFiles: 0, totalFiles: 0 }
  )

/**
 * Whether a confirmed batch is a partial import.
 *
 * @param batch - Every file's result
 * @returns `true` when any resource failed to write
 *
 * @remarks
 * The `collectImportSummary` semantics, lifted to the batch: **any** rejected
 * resource — the source-file archive included, since it now writes in the same
 * batch — makes the whole batch partial. A `skipped` file is not a failure
 * (an empty preview is ordinary data), so it does not make a batch partial on
 * its own.
 */
const isPartialBatch = (batch: BatchOutcome): boolean =>
  batch.some((result) => result._tag === 'imported' && isPartialOutcome(result.outcome))

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
