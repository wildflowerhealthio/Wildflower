/**
 * Plan totals: how many records an import plan creates, updates and links,
 * and how many need a decision, overall and per file set.
 *
 * @packageDocumentation
 */
import type { Array as Arr } from 'effect'

import type * as PickedFile from '../../picked-file.ts'

/**
 * Counts over some records of a plan.
 *
 * @remarks
 * `records` counts every record, one per key. `needsDecision` counts the
 * records listed under Needs a decision, and `open` those of them with no
 * choice yet. A record that is not added counts in `records` alone.
 */
interface Counts {
  readonly records: number
  readonly create: number
  readonly update: number
  readonly linkToExisting: number
  readonly needsDecision: number
  readonly open: number
}

/** The counts of the records one file set brought. */
interface FileSetCounts {
  /** The file set's picked files, in pick order. */
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>
  readonly counts: Counts
}

/** A plan's counts overall, and per file set in the order the sets first bring a record. */
interface Type {
  readonly overall: Counts
  readonly fileSets: readonly FileSetCounts[]
}

export type { Counts, FileSetCounts, Type }
