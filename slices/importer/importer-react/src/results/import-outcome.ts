import type { ResourceWriteFailure } from 'fhir-r4/clients'
import type { Preview } from 'importer-core'

/**
 * What a confirmed import wrote, and what it could not — the value the results
 * view reads and the `partial` decision folds over.
 *
 * @remarks
 * The write half (`importer-core`'s `persistPreview`) returns only the resources
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
const previewResourceCount = (preview: Preview): number =>
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
  preview: Preview,
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

export { type ImportOutcome, importOutcome, isPartialOutcome, previewResourceCount }
