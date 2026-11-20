/**
 * An import plan: one choice per record of an import, over every file that
 * brought it, suggested from what the store holds and changed by the
 * reviewer.
 *
 * @packageDocumentation
 */
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource, LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal, type HashMap, HashSet, Option } from 'effect'

import type * as PlannedRecord from './planned-record.ts'
import type * as RecordChoice from './record-choice.ts'
import type * as RecordKey from './record-key.ts'

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

/**
 * The plan of `records`, in plan order, beside the stored candidates of each
 * logical reference that names no record of the import.
 */
const make = (
  records: readonly PlannedRecord.Type[],
  unresolvedReferences: Type['unresolvedReferences']
): Type => ({ records, unresolvedReferences })

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
