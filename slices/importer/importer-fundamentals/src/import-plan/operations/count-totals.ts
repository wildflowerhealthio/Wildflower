/**
 * Count totals: what counts where in an import plan's totals, overall and per
 * file set.
 *
 * @packageDocumentation
 */
import { Array as Arr } from 'effect'

import type * as PickedFile from '../../picked-file.ts'
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

/** The id a file set is told apart by: its first picked file's. */
const fileSetIdOf = (pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>): string =>
  pickedFiles[0].id

/** Whether one of `planned`'s copies came from the file set told apart by `fileSetId`. */
const broughtBy = (planned: PlannedRecord.Type, fileSetId: string): boolean =>
  planned.copies.some(({ pickedFiles }) => fileSetIdOf(pickedFiles) === fileSetId)

/**
 * `plan`'s counts: overall, and for each file set the records it brought a
 * copy of, so a record two sets bring counts in each set's line.
 */
const countTotals = (plan: ImportPlan.Type): PlanTotals.Type => ({
  overall: countsOf(plan.records),
  fileSets: Arr.dedupeWith(
    plan.records.flatMap(({ copies }) => copies.map(({ pickedFiles }) => pickedFiles)),
    (left, right) => fileSetIdOf(left) === fileSetIdOf(right)
  ).map((pickedFiles) => ({
    pickedFiles,
    counts: countsOf(
      plan.records.filter((planned) => broughtBy(planned, fileSetIdOf(pickedFiles)))
    ),
  })),
})

export { countTotals }
