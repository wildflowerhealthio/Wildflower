/**
 * Plan totals: how many records an import plan creates, updates and links,
 * and how many need a decision, overall and per file set.
 *
 * @packageDocumentation
 */
import { Number as Num, Record, Schema } from 'effect'

import type * as FileSetOrigin from './file-set-origin.ts'
import * as PlanResolution from './plan-resolution.ts'

/** How many records carry each label, every label present. */
const CountsByLabelSchema = Schema.Record({
  key: PlanResolution.LabelSchema,
  value: Schema.NonNegativeInt,
})

/**
 * Counts over some records of a plan.
 *
 * @remarks
 * `byLabel` counts the records under each label of their resolution
 * (`PlanResolution.Label`), every label present, so the records under `Open`
 * are those with no choice yet, and a record nothing is written for though
 * its choice would write it counts under `Unneeded`, never `Create` or
 * `Update`. `needsDecision` counts the records listed under Needs a decision,
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
 * `PlanResolution.labels`, every label present, and `needsDecision`.
 *
 * @throws When a count is not a non-negative integer, a defect, since
 *   every count is a number of records.
 */
const makeCounts = (
  recordsLabelled: (label: PlanResolution.Label) => number,
  needsDecision: number
): Counts => ({
  byLabel: decodeCountsByLabel(
    Record.fromIterableWith(
      PlanResolution.labels,
      (label) => [label, recordsLabelled(label)] as const
    )
  ),
  needsDecision,
})

/** The counts of the records the file set `origin` names brought. */
const makeFileSetCounts = (origin: FileSetOrigin.Type, counts: Counts): FileSetCounts => ({
  origin,
  counts,
})

/** A plan's counts: `overall`, and `fileSets` in the order the sets first bring a record. */
const make = (overall: Counts, fileSets: readonly FileSetCounts[]): Type => ({ overall, fileSets })

/** How many records `counts` counts, one per key: every record has one label. */
const recordsOf = (counts: Counts): number => Num.sumAll(Record.values(counts.byLabel))

export { make, makeCounts, makeFileSetCounts, recordsOf }
export type { Counts, FileSetCounts, Type }
