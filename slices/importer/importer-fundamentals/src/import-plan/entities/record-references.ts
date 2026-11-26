/**
 * Record references: what an import's records say of each other by their
 * logical references, before any is resolved.
 *
 * @packageDocumentation
 */
import type { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet } from 'effect'

import type * as RecordKey from './record-key.ts'

/**
 * The records of an import that another of its records references, and the
 * logical references no record of the import carries the identifier of.
 */
interface Type {
  readonly referenced: HashSet.HashSet<RecordKey.Type>
  /** Each distinct logical reference no record of the import carries the identifier of, in record order. */
  readonly notInImport: readonly LogicalReference.Type[]
}

/** The record references of `referenced` records and `notInImport` references. */
const make = ({ referenced, notInImport }: Type): Type => ({ referenced, notInImport })

/** Whether another record of the import references the record under `key`. */
const isReferenced = (recordReferences: Type, key: RecordKey.Type): boolean =>
  HashSet.has(recordReferences.referenced, key)

export { isReferenced, make }
export type { Type }
