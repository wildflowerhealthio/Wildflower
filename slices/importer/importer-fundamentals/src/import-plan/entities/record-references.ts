/**
 * Record references: what an import's records say of each other by their
 * logical references, before any is resolved.
 *
 * @packageDocumentation
 */
import type { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet } from 'effect'

import type * as RecordKey from './record-key.ts'

/** A logical reference that names a record of an import, and the key of the record it names. */
interface NamedRecord {
  readonly logicalReference: LogicalReference.Type
  readonly key: RecordKey.Type
}

/**
 * The records of an import that another of its records references, the
 * logical references that name a record of the import, and the import's
 * external references.
 */
interface Type {
  readonly referenced: HashSet.HashSet<RecordKey.Type>
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

/** The record references of `referenced` records, `named` records and `external` references. */
const make = ({ referenced, named, external }: Type): Type => ({
  referenced,
  named,
  external,
})

/** Whether another record of the import references the record under `key`. */
const isReferenced = (recordReferences: Type, key: RecordKey.Type): boolean =>
  HashSet.has(recordReferences.referenced, key)

export { isReferenced, make }
export type { NamedRecord, Type }
