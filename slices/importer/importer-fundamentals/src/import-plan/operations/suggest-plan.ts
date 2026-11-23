/**
 * Suggest a plan: every record of an import suggested in change order, so
 * that two records using one stored record never take one field twice.
 *
 * @packageDocumentation
 */
import { literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, Option, Order } from 'effect'

import * as ChangedStoredRecord from '../entities/changed-stored-record.ts'
import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import * as RecordReferences from '../entities/record-references.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import * as ComparableReferences from './compare-to-stored/comparable-references.ts'
import { suggestRecord } from './suggest-record.ts'

/** Each stored record with the changes of the records suggested so far, by its literal reference. */
type ChangedSoFar = HashMap.HashMap<string, ChangedStoredRecord.Type>

/** `changedSoFar` with `planned`'s suggested change made, when its suggestion uses a stored record. */
const withSuggestedChange = (
  changedSoFar: ChangedSoFar,
  planned: PlannedRecord.Type
): ChangedSoFar =>
  Option.match(
    Option.flatMap(
      planned.suggestion.choice,
      Option.liftPredicate(RecordChoice.is('UseExistingRecord'))
    ),
    {
      onNone: () => changedSoFar,
      onSome: ({ existing, fieldsTaken }) =>
        HashMap.modifyAt(changedSoFar, literalReferenceOf(existing), (changed) =>
          Option.some(
            ChangedStoredRecord.withChange(
              Option.getOrElse(changed, () => ChangedStoredRecord.of(existing)),
              { resource: ImportedRecord.resourceOf(planned.record), fieldsTaken }
            )
          )
        ),
    }
  )

/**
 * One record of the plan: what the store holds of it and its suggestion, its
 * offered fields measured against the stored records as the records ahead
 * of it changed them (`changedSoFar`), nothing chosen and nothing edited.
 */
const planRecord = (
  storedMatch: StoredMatch.Type,
  recordReferences: RecordReferences.Type,
  comparableReferences: ComparableReferences.Type,
  changedSoFar: ChangedSoFar,
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
      changedSoFar,
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
 * @param recordReferences - The references between them (`RecordReferences.of`)
 * @param storedMatch - What the store holds of the import's records and its
 *   unresolved references
 *
 * @remarks
 * Records are suggested in change order (`ImportedRecord.changeOrder`, then
 * plan order): decoded records first, implied ones after. A record suggested
 * to use a stored record a record ahead of it is suggested to use has its
 * offered fields measured against that stored record as the earlier
 * change leaves it (`ChangedStoredRecord.asItStands`), so two suggestions
 * never take one field twice, and a decoded record never leaves a field to
 * an implied record the write may drop. References compare by what they
 * name (`ComparableReferences`), not by their literal.
 */
const suggestPlan = (
  records: readonly ImportedRecord.Type[],
  recordReferences: RecordReferences.Type,
  storedMatch: StoredMatch.Type
): ImportPlan.Type => {
  const comparableReferences = ComparableReferences.of(records, storedMatch)
  const inChangeOrder = Arr.sort(
    Arr.map(records, (value, position): PlacedInPlan<ImportedRecord.Type> => ({ position, value })),
    Order.combine(
      Order.mapInput(
        ImportedRecord.changeOrder,
        ({ value }: PlacedInPlan<ImportedRecord.Type>) => value
      ),
      byPosition
    )
  )
  const [, planned] = Arr.mapAccum(
    inChangeOrder,
    HashMap.empty<string, ChangedStoredRecord.Type>(),
    (
      changedSoFar,
      { position, value: record }
    ): [ChangedSoFar, PlacedInPlan<PlannedRecord.Type>] => {
      const plannedRecord = planRecord(
        storedMatch,
        recordReferences,
        comparableReferences,
        changedSoFar,
        record
      )
      return [withSuggestedChange(changedSoFar, plannedRecord), { position, value: plannedRecord }]
    }
  )
  return ImportPlan.make(
    Arr.map(Arr.sort(planned, byPosition), ({ value }) => value),
    storedMatch
  )
}

export { suggestPlan }
