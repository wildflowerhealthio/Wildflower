/**
 * Suggest a plan: every record of an import suggested in plan order, so that
 * two records using one stored record never take one field twice.
 *
 * @packageDocumentation
 */
import { literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, Option } from 'effect'

import * as FileCopy from '../entities/imported-copy.ts'
import * as ImportPlan from '../entities/import-plan.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import * as RecordReferences from '../entities/record-references.ts'
import type * as StoredMatch from '../entities/stored-match.ts'
import type { TakenFields } from './compare-to-stored/compare-to-stored.ts'
import { suggestRecord } from './suggest-record.ts'

/** The fields each stored record takes from the records suggested so far, by its literal reference. */
type TakenEarlier = HashMap.HashMap<string, readonly TakenFields[]>

/** `takenEarlier` with the fields `planned`'s suggestion takes from it added, when it uses a stored record. */
const withTakenBy = (takenEarlier: TakenEarlier, planned: PlannedRecord.Type): TakenEarlier =>
  Option.match(
    Option.flatMap(
      planned.suggestion.choice,
      Option.liftPredicate(RecordChoice.is('UseExistingRecord'))
    ),
    {
      onNone: () => takenEarlier,
      onSome: ({ existing, fieldsTaken }) =>
        HashMap.modifyAt(takenEarlier, literalReferenceOf(existing), (earlier) =>
          Option.some([
            ...Option.getOrElse(earlier, () => []),
            { resource: planned.copies[0].resource, fields: fieldsTaken },
          ])
        ),
    }
  )

/**
 * One record of the plan: its stored candidates and its suggestion, its
 * offered fields measured after `takenEarlier`, nothing chosen and nothing
 * edited.
 */
const planRecord = (
  storedMatch: StoredMatch.Type,
  recordReferences: RecordReferences.Type,
  takenEarlier: TakenEarlier,
  { key, copies }: FileCopy.RecordCopies
): PlannedRecord.Type => {
  const candidates = HashMap.get(storedMatch.candidatesByRecord, key).pipe(
    Option.getOrElse(() => [])
  )
  return PlannedRecord.make({
    key,
    copies,
    candidates,
    suggestion: suggestRecord({
      resource: copies[0].resource,
      candidates,
      storedUnderDerivedId: HashMap.get(storedMatch.storedUnderDerivedIdByRecord, key),
      isReferenced: RecordReferences.isReferenced(recordReferences, key),
      takenEarlier,
    }),
  })
}

/**
 * The plan of `copies`, every record suggested from `storedMatch`, nothing
 * chosen and nothing edited.
 *
 * @param copies - Every copy of every record of the import, in plan order
 * @param storedMatch - What the store holds of the import's records and its
 *   unresolved references
 *
 * @remarks
 * Records are suggested in plan order. A record suggested to use a stored
 * record an earlier one is suggested to use has its offered fields measured
 * after the earlier one's taken fields are in place, so two suggestions never
 * take one field twice.
 */
const suggestPlan = (
  copies: readonly FileCopy.Type[],
  storedMatch: StoredMatch.Type
): ImportPlan.Type => {
  const records = FileCopy.groupByRecord(copies)
  const recordReferences = RecordReferences.of(records)
  const [, planned] = Arr.mapAccum(
    records,
    HashMap.empty<string, readonly TakenFields[]>(),
    (takenEarlier, record): [TakenEarlier, PlannedRecord.Type] => {
      const plannedRecord = planRecord(storedMatch, recordReferences, takenEarlier, record)
      return [withTakenBy(takenEarlier, plannedRecord), plannedRecord]
    }
  )
  return ImportPlan.make(planned, storedMatch.candidatesByUnresolvedReference)
}

export { suggestPlan }
