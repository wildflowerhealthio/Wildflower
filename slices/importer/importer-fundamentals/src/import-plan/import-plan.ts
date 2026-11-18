/**
 * An import plan: one choice per record of an import, over every file that
 * brought it, suggested from what the store holds and changed by the
 * reviewer.
 *
 * @packageDocumentation
 */
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type FhirResource,
  type LogicalReference,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal, HashMap, HashSet, Option } from 'effect'

import * as FileCopy from './file-copy.ts'
import type * as OfferedFields from './offered-fields.ts'
import type * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'
import type * as RecordKey from './record-key.ts'
import * as RecordReferences from './record-references.ts'
import type * as StoredMatch from './stored-match.ts'
import * as Suggestion from './suggestion.ts'

/**
 * Every record of an import, in plan order, and the stored candidates of
 * each logical reference that names no record of the import.
 *
 * @remarks
 * Plan order is the order the records' first copies came in.
 */
interface Type {
  readonly records: readonly PlannedRecord.Type[]
  /** Each unresolved logical reference's candidates, best grade first, by `LogicalReference.key`. */
  readonly unresolvedReferences: HashMap.HashMap<
    LogicalReference.Key,
    readonly ResourceMatch.Candidate[]
  >
}

/** The fields each stored record takes from the records suggested so far, by its literal reference. */
type TakenEarlier = HashMap.HashMap<string, readonly OfferedFields.TakenFields[]>

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
  return {
    key,
    copies,
    candidates,
    suggestion: Suggestion.forRecord({
      resource: copies[0].resource,
      candidates,
      storedUnderDerivedId: HashMap.get(storedMatch.storedUnderDerivedIdByRecord, key),
      isReferenced: RecordReferences.isReferenced(recordReferences, key),
      takenEarlier,
    }),
    chosen: Option.none(),
    edit: Option.none(),
  }
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
const make = (copies: readonly FileCopy.Type[], storedMatch: StoredMatch.Type): Type => {
  const records = FileCopy.groupByRecord(copies)
  const recordReferences = RecordReferences.of(records)
  const [, planned] = Arr.mapAccum(
    records,
    HashMap.empty<string, readonly OfferedFields.TakenFields[]>(),
    (takenEarlier, record): [TakenEarlier, PlannedRecord.Type] => {
      const plannedRecord = planRecord(storedMatch, recordReferences, takenEarlier, record)
      return [withTakenBy(takenEarlier, plannedRecord), plannedRecord]
    }
  )
  return { records: planned, unresolvedReferences: storedMatch.candidatesByUnresolvedReference }
}

/** The record of `plan` under `key`. */
const get = (plan: Type, key: RecordKey.Type): Option.Option<PlannedRecord.Type> =>
  Arr.findFirst(plan.records, (planned) => Equal.equals(planned.key, key))

/** `plan` with `f` applied to each record under one of `keys`. */
const modifyRecords = (
  plan: Type,
  keys: Iterable<RecordKey.Type>,
  f: (planned: PlannedRecord.Type) => PlannedRecord.Type
): Type => {
  const modified = HashSet.fromIterable(keys)
  return {
    ...plan,
    records: plan.records.map((planned) =>
      HashSet.has(modified, planned.key) ? f(planned) : planned
    ),
  }
}

/** `plan` with the reviewer's `choice` for every record under one of `keys`. */
const choose = (plan: Type, keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type): Type =>
  modifyRecords(plan, keys, (planned) => ({ ...planned, chosen: Option.some(choice) }))

/** `plan` with the reviewer's choice cleared for every record under one of `keys`, back to its suggestion. */
const reset = (plan: Type, keys: Iterable<RecordKey.Type>): Type =>
  modifyRecords(plan, keys, (planned) => ({ ...planned, chosen: Option.none() }))

/** `plan` with the record under `key` edited to `edit`, or its edit cleared by `None`. */
const setEdit = (plan: Type, key: RecordKey.Type, edit: Option.Option<FhirResource>): Type =>
  modifyRecords(plan, [key], (planned) => ({ ...planned, edit }))

export { choose, get, make, reset, setEdit }
export type { Type }
