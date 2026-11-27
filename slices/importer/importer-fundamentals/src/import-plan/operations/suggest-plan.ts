/**
 * Suggest a plan: every record of an import suggested in merge order, so
 * that two records merging into one kept record never take one field twice.
 *
 * @packageDocumentation
 */
import { Array as Arr, Order } from 'effect'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as KeptRecords from '../entities/kept-records.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordReferences from '../entities/record-references.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import * as ComparableReferences from './differences-of/comparable-references.ts'
import { suggestRecord } from './suggest-record.ts'

/**
 * One record of the plan: what the store holds of it and its suggestion, its
 * differences measured against the kept records as the records ahead of it
 * merged into them (`mergedSoFar`), nothing chosen and nothing edited.
 */
const planRecord = (
  storedMatch: StoredMatch.Type,
  recordReferences: RecordReferences.Type,
  comparableReferences: ComparableReferences.Type,
  mergedSoFar: KeptRecords.Type,
  record: ImportedRecord.Type
): PlannedRecord.Type => {
  const recordMatch = StoredMatch.ofRecord(storedMatch, record.key)
  return PlannedRecord.make({
    record,
    storedMatch: recordMatch,
    suggestion: suggestRecord({
      resource: ImportedRecord.resourceOf(record),
      storedMatch: recordMatch,
      isReferenced: RecordReferences.isReferenced(recordReferences, record.key),
      mergedSoFar,
      comparableReferences,
    }),
  })
}

/** A record beside its position in plan order. */
interface PlacedInPlan<A> {
  readonly position: number
  readonly value: A
}

/** In plan order: by position. */
const byPosition = Order.mapInput(Order.number, ({ position }: PlacedInPlan<unknown>) => position)

/**
 * The plan of `records`, every record suggested from `storedMatch`, nothing
 * chosen and nothing edited, the records in plan order.
 *
 * @param records - The import's records, in plan order (`ImportedRecord.fromCopies`)
 * @param recordReferences - The references between them (`locateReferences`)
 * @param storedMatch - What the store holds of the import's records and of
 *   its external references
 *
 * @remarks
 * Records are suggested in merge order (`ImportedRecord.inMergeOrder`:
 * `ImportedRecord.mergeOrder`, then plan order): decoded records first,
 * implied ones after. A record suggested to merge into a stored record a record ahead of
 * it is suggested to merge into has its differences measured against that
 * kept record as the earlier merge leaves it (`KeptRecords.asMergedIn`), so two
 * suggestions never take one field twice, and a decoded record never leaves
 * a field to an implied record the write may drop. References compare by
 * what they name (`ComparableReferences`), not by their literal.
 */
const suggestPlan = (
  records: readonly ImportedRecord.Type[],
  recordReferences: RecordReferences.Type,
  storedMatch: StoredMatch.Type
): ImportPlan.Type => {
  const comparableReferences = ComparableReferences.of(records, storedMatch)
  const inMergeOrder = ImportedRecord.inMergeOrder(
    Arr.map(records, (value, position): PlacedInPlan<ImportedRecord.Type> => ({ position, value })),
    ({ value }) => value
  )
  /** The next record suggested against the merges suggested so far, and those merges with its own. */
  const suggestNext = (
    mergedSoFar: KeptRecords.Type,
    { position, value: record }: PlacedInPlan<ImportedRecord.Type>
  ): [KeptRecords.Type, PlacedInPlan<PlannedRecord.Type>] => {
    const planned = planRecord(
      storedMatch,
      recordReferences,
      comparableReferences,
      mergedSoFar,
      record
    )
    return [
      KeptRecords.withRecordChoice(mergedSoFar, KeptRecords.asReviewed(planned)),
      { position, value: planned },
    ]
  }
  const [, planned] = Arr.mapAccum(inMergeOrder, KeptRecords.empty, suggestNext)
  return ImportPlan.make(
    Arr.map(Arr.sort(planned, byPosition), ({ value }) => value),
    storedMatch
  )
}

export { suggestPlan }
