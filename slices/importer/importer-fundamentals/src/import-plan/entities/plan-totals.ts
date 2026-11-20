/**
 * Plan totals: how many records an import plan creates, updates and links,
 * and how many need a decision, overall and per file set.
 *
 * @packageDocumentation
 */
import { Array as Arr, Record, Schema } from 'effect'

import type * as FileSetOrigin from './file-set-origin.ts'
import * as PlannedRecord from './planned-record.ts'

/** How many records carry each label, every label present. */
const CountsByLabelSchema = Schema.Record({
  key: PlannedRecord.LabelSchema,
  value: Schema.NonNegativeInt,
})

/**
 * Counts over some records of a plan.
 *
 * @remarks
 * `byLabel` counts the records under each label (`PlannedRecord.labelOf`),
 * every label present, so the records under `Open` are those with no choice
 * yet. `needsDecision` counts the records listed under Needs a decision,
 * whatever their label; every `Open` record is one of them.
 */
interface Counts {
  readonly byLabel: typeof CountsByLabelSchema.Type
  readonly needsDecision: number
}

/** The counts of the records one file set brought. */
interface FileSetCounts {
  readonly origin: FileSetOrigin.Type
  readonly counts: Counts
}

/** A plan's counts overall, and per file set in the order the sets first bring a record. */
interface Type {
  readonly overall: Counts
  readonly fileSets: readonly FileSetCounts[]
}

const decodeCountsByLabel = Schema.decodeUnknownSync(CountsByLabelSchema)

/**
 * The counts of some records: `recordsLabelled(label)` under each label of
 * `PlannedRecord.labels`, every label present, and `needsDecision`.
 *
 * @throws When a count is not a non-negative integer, a defect, since
 *   every count is a number of records.
 */
const makeCounts = (
  recordsLabelled: (label: PlannedRecord.Label) => number,
  needsDecision: number
): Counts => ({
  byLabel: decodeCountsByLabel(
    Record.fromIterableWith(
      PlannedRecord.labels,
      (label) => [label, recordsLabelled(label)] as const
    )
  ),
  needsDecision,
})

/** How many records `counts` counts, one per key: every record has one label. */
const recordsOf = (counts: Counts): number =>
  Arr.reduce(Record.values(counts.byLabel), 0, (sum, n) => sum + n)

export { makeCounts, recordsOf }
export type { Counts, FileSetCounts, Type }
