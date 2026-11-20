/**
 * Count totals: what counts where in a resolved import plan's totals, overall
 * and per file set.
 *
 * @packageDocumentation
 */
import { Array as Arr, Option, Record } from 'effect'

import * as FileSetOrigin from '../entities/file-set-origin.ts'
import type * as PlanResolution from '../entities/plan-resolution.ts'
import * as PlanTotals from '../entities/plan-totals.ts'
import * as PlannedRecord from '../entities/planned-record.ts'

/**
 * The counts of `records`: grouped by their resolution's label, a label no
 * record has counting zero, and those that need a decision.
 */
const countsOf = (records: readonly PlanResolution.ResolvedRecord[]): PlanTotals.Counts => {
  const byLabel = Arr.groupBy(records, ({ label }) => label)
  return PlanTotals.makeCounts(
    (label) =>
      Record.get(byLabel, label).pipe(
        Option.match({ onNone: () => 0, onSome: (labelled) => labelled.length })
      ),
    Arr.filter(records, ({ planned }) => PlannedRecord.needsDecision(planned)).length
  )
}

/** Whether one of `resolved`'s copies came from the file set `origin` names. */
const broughtBy = (
  { planned }: PlanResolution.ResolvedRecord,
  origin: FileSetOrigin.Type
): boolean => planned.record.copies.some((copy) => FileSetOrigin.equivalence(copy.origin, origin))

/**
 * `resolution`'s counts: overall, and for each file set the records it
 * brought a copy of, so a record two sets bring counts in each set's line.
 */
const countTotals = (resolution: PlanResolution.Type): PlanTotals.Type =>
  PlanTotals.make(
    countsOf(resolution.records),
    Arr.dedupeWith(
      resolution.records.flatMap(({ planned }) =>
        planned.record.copies.map(({ origin }) => origin)
      ),
      FileSetOrigin.equivalence
    ).map((origin) =>
      PlanTotals.makeFileSetCounts(
        origin,
        countsOf(resolution.records.filter((resolved) => broughtBy(resolved, origin)))
      )
    )
  )

export { countTotals }
