/**
 * Count totals: what counts where in an import plan's totals, overall and per
 * file set.
 *
 * @packageDocumentation
 */
import { Array as Arr } from 'effect'

import * as FileSetOrigin from '../entities/file-set-origin.ts'
import type * as ImportPlan from '../entities/import-plan.ts'
import type * as PlanTotals from '../entities/plan-totals.ts'
import * as PlannedRecord from '../entities/planned-record.ts'

/** No record. */
const NO_RECORDS: PlanTotals.Counts = {
  records: 0,
  create: 0,
  update: 0,
  linkToExisting: 0,
  needsDecision: 0,
  open: 0,
}

/** `counts` with `planned` counted. */
const withRecord = (counts: PlanTotals.Counts, planned: PlannedRecord.Type): PlanTotals.Counts => {
  const label = PlannedRecord.labelOf(planned)
  return {
    records: counts.records + 1,
    create: counts.create + (label === 'Create' ? 1 : 0),
    update: counts.update + (label === 'Update' ? 1 : 0),
    linkToExisting: counts.linkToExisting + (label === 'LinkToExisting' ? 1 : 0),
    needsDecision: counts.needsDecision + (PlannedRecord.needsDecision(planned) ? 1 : 0),
    open: counts.open + (label === 'Open' ? 1 : 0),
  }
}

/** The counts of `records`. */
const countsOf = (records: readonly PlannedRecord.Type[]): PlanTotals.Counts =>
  records.reduce(withRecord, NO_RECORDS)

/** Whether one of `planned`'s copies came from the file set `origin` names. */
const broughtBy = (planned: PlannedRecord.Type, origin: FileSetOrigin.Type): boolean =>
  planned.record.copies.some((copy) => FileSetOrigin.equivalence(copy.origin, origin))

/**
 * `plan`'s counts: overall, and for each file set the records it brought a
 * copy of, so a record two sets bring counts in each set's line.
 */
const countTotals = (plan: ImportPlan.Type): PlanTotals.Type => ({
  overall: countsOf(plan.records),
  fileSets: Arr.dedupeWith(
    plan.records.flatMap(({ record }) => record.copies.map(({ origin }) => origin)),
    FileSetOrigin.equivalence
  ).map((origin) => ({
    pickedFiles: origin.pickedFiles,
    counts: countsOf(plan.records.filter((planned) => broughtBy(planned, origin))),
  })),
})

export { countTotals }
