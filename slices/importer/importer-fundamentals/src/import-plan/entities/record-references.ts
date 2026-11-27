/**
 * Record references: what an import's records say of each other by their
 * logical references, before any is resolved.
 *
 * @packageDocumentation
 */
import type { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { type Array as Arr, HashMap, Option } from 'effect'

import type * as RecordKey from './record-key.ts'

/** A logical reference that names a record of an import, and the key of the record it names. */
interface NamedRecord {
  readonly logicalReference: LogicalReference.Type
  readonly key: RecordKey.Type
}

/**
 * Who references each record of an import, the logical references that name
 * a record of the import, and the import's external references.
 */
interface Type {
  /**
   * Each record another record of the import references, beside its
   * referrers: the records holding a logical reference that names it, in
   * plan order, each once. A record is never its own referrer.
   */
  readonly referrers: HashMap.HashMap<RecordKey.Type, Arr.NonEmptyReadonlyArray<RecordKey.Type>>
  /**
   * Each logical reference by a qualified identifier a record of the import
   * carries that names one of them, beside its key: one per identifier, in
   * the order the identifiers are first carried.
   */
  readonly named: readonly NamedRecord[]
  /**
   * Each distinct external reference, in record order: an unlinked reference
   * a record holds that points outside the import, since no record of the
   * import carries its identifier.
   */
  readonly external: readonly LogicalReference.Type[]
}

/** The record references of each record's `referrers`, `named` records and `external` references. */
const make = ({ referrers, named, external }: Type): Type => ({
  referrers,
  named,
  external,
})

/** Whether another record of the import references the record under `key`. */
const isReferenced = (recordReferences: Type, key: RecordKey.Type): boolean =>
  HashMap.has(recordReferences.referrers, key)

/**
 * The records holding a logical reference that names the record under
 * `key`, in plan order, each once; none when nothing else references it.
 */
const referrersOf = (recordReferences: Type, key: RecordKey.Type): readonly RecordKey.Type[] =>
  HashMap.get(recordReferences.referrers, key).pipe(Option.getOrElse(() => []))

export { isReferenced, make, referrersOf }
export type { NamedRecord, Type }
