/**
 * Suggest a plan: every record of an import suggested in plan order, so that
 * two records using one stored record never take one field twice.
 *
 * @packageDocumentation
 */
import { literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, Option } from 'effect'

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

/**
 * The plan of `records`, every record suggested from `storedMatch`, nothing
 * chosen and nothing edited.
 *
 * @param records - The import's records, in plan order (`ImportedRecord.fromCopies`)
 * @param recordReferences - The references between them (`RecordReferences.of`)
 * @param storedMatch - What the store holds of the import's records and its
 *   unresolved references
 *
 * @remarks
 * Records are suggested in plan order. A record suggested to use a stored
 * record an earlier one is suggested to use has its offered fields measured
 * against that stored record as the earlier one's change leaves it
 * (`ChangedStoredRecord.asItStands`), so two suggestions never take one
 * field twice. References compare by what they name
 * (`ComparableReferences`), not by their literal.
 */
const suggestPlan = (
  records: readonly ImportedRecord.Type[],
  recordReferences: RecordReferences.Type,
  storedMatch: StoredMatch.Type
): ImportPlan.Type => {
  const comparableReferences = ComparableReferences.of(records, storedMatch)
  const [, planned] = Arr.mapAccum(
    records,
    HashMap.empty<string, ChangedStoredRecord.Type>(),
    (changedSoFar, record): [ChangedSoFar, PlannedRecord.Type] => {
      const plannedRecord = planRecord(
        storedMatch,
        recordReferences,
        comparableReferences,
        changedSoFar,
        record
      )
      return [withSuggestedChange(changedSoFar, plannedRecord), plannedRecord]
    }
  )
  return ImportPlan.make(planned, storedMatch)
}

export { suggestPlan }
