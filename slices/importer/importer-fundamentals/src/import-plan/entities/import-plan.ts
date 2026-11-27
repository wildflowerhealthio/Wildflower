/**
 * An import plan: one choice per record of an import, over every file that
 * brought it, suggested from what the store holds and changed by the
 * reviewer.
 *
 * @packageDocumentation
 */
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal, HashSet, type Option } from 'effect'

import * as PlannedRecord from './planned-record.ts'
import type * as RecordChoice from './record-choice.ts'
import type * as RecordKey from './record-key.ts'
import type * as StoredMatch from './stored-match.ts'

/**
 * Every record of an import, in plan order, and what the store holds of the
 * import: of each record, and of each external reference's target
 * (`StoredMatch.ofReference`).
 *
 * @remarks
 * Plan order is the order the records' first copies came in.
 */
interface Type {
  readonly records: readonly PlannedRecord.Type[]
  readonly storedMatch: StoredMatch.Type
}

/** The plan of `records`, in plan order, beside the import's `storedMatch`. */
const make = (records: readonly PlannedRecord.Type[], storedMatch: StoredMatch.Type): Type => ({
  records,
  storedMatch,
})

/** The record of `plan` under `key`. */
const get = (plan: Type, key: RecordKey.Type): Option.Option<PlannedRecord.Type> =>
  Arr.findFirst(plan.records, (planned) => Equal.equals(planned.record.key, key))

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
      HashSet.has(modified, planned.record.key) ? f(planned) : planned
    ),
  }
}

/** `plan` with the reviewer's `choice` for every record under one of `keys`. */
const choose = (plan: Type, keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type): Type =>
  modifyRecords(plan, keys, (planned) => PlannedRecord.withChoice(planned, choice))

/** `plan` with the reviewer's choice cleared for every record under one of `keys`, back to its suggestion. */
const reset = (plan: Type, keys: Iterable<RecordKey.Type>): Type =>
  modifyRecords(plan, keys, PlannedRecord.withChoiceCleared)

/** `plan` with the record under `key` edited to `edit`, or its edit cleared by `None`. */
const setEdit = (plan: Type, key: RecordKey.Type, edit: Option.Option<FhirResource>): Type =>
  modifyRecords(plan, [key], (planned) => PlannedRecord.withEdit(planned, edit))

export { choose, get, make, reset, setEdit }
export type { Type }
