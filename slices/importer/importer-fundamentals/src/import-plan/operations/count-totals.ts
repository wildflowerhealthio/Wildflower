/**
 * Count totals: what counts where in an import plan's totals, overall and per
 * file set.
 *
 * @packageDocumentation
 */
import { Array as Arr, Option, Record } from 'effect'

import * as FileSetOrigin from '../entities/file-set-origin.ts'
import type * as ImportPlan from '../entities/import-plan.ts'
import * as PlanTotals from '../entities/plan-totals.ts'
import * as PlannedRecord from '../entities/planned-record.ts'

/**
 * The counts of `records`: grouped by label (`PlannedRecord.labelOf`), a
 * label no record has counting zero, and those that need a decision.
 */
const countsOf = (records: readonly PlannedRecord.Type[]): PlanTotals.Counts => {
  const byLabel = Arr.groupBy(records, PlannedRecord.labelOf)
  return PlanTotals.makeCounts(
    (label) =>
      Record.get(byLabel, label).pipe(
        Option.match({ onNone: () => 0, onSome: (labelled) => labelled.length })
      ),
    Arr.filter(records, PlannedRecord.needsDecision).length
  )
}

/** Whether one of `planned`'s copies came from the file set `origin` names. */
const broughtBy = (planned: PlannedRecord.Type, origin: FileSetOrigin.Type): boolean =>
  planned.record.copies.some((copy) => FileSetOrigin.equivalence(copy.origin, origin))

/**
 * `plan`'s counts: overall, and for each file set the records it brought a
 * copy of, so a record two sets bring counts in each set's line.
 */
const countTotals = (plan: ImportPlan.Type): PlanTotals.Type =>
  PlanTotals.make(
    countsOf(plan.records),
    Arr.dedupeWith(
      plan.records.flatMap(({ record }) => record.copies.map(({ origin }) => origin)),
      FileSetOrigin.equivalence
    ).map((origin) =>
      PlanTotals.makeFileSetCounts(
        origin,
        countsOf(plan.records.filter((planned) => broughtBy(planned, origin)))
      )
    )
  )

export { countTotals }
