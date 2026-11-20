/**
 * Record references: what an import's records say of each other by their
 * logical references, before any is resolved.
 *
 * @packageDocumentation
 */
import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal, HashSet, Option, pipe, Record } from 'effect'

import type * as ImportedRecord from './imported-record.ts'
import * as RecordKey from './record-key.ts'

/** A logical reference that names records of an import, and the keys of the records it names. */
interface NamedRecords {
  readonly logicalReference: LogicalReference.Type
  readonly keys: Arr.NonEmptyReadonlyArray<RecordKey.Type>
}

/**
 * The records of an import that another of its records references, the
 * logical references that name records of the import, and those that name
 * none.
 */
interface Type {
  readonly referenced: HashSet.HashSet<RecordKey.Type>
  /** Each logical reference naming a keyed record of the import ({@link namedRecordsOf}). */
  readonly named: readonly NamedRecords[]
  /** Each distinct logical reference naming no record of the import, in record order. */
  readonly unresolved: readonly LogicalReference.Type[]
}

/**
 * Every logical reference that names a keyed record of `records`, by any
 * qualified identifier any copy of the record carries, beside the records it
 * names: one record, or several that share the identifier.
 *
 * @remarks
 * A logical reference names a record by any of its identifiers, as a FHIR
 * conditional reference does and as `DecodedFileSet.adopt` resolves one. A
 * keyless record's identifiers name it nowhere.
 */
const namedRecordsOf = (records: readonly ImportedRecord.Type[]): readonly NamedRecords[] =>
  pipe(
    records.filter(({ key }) => RecordKey.isKeyed(key)),
    Arr.flatMap(({ key, copies }) =>
      copies.flatMap(({ resource }) =>
        MatchQuery.qualifiedIdentifiersOf(resource).map((identifier) => ({
          logicalReference: LogicalReference.make(resource.resourceType, identifier),
          key,
        }))
      )
    ),
    Arr.groupBy(({ logicalReference }) => LogicalReference.key(logicalReference)),
    Record.values,
    Arr.map((named): NamedRecords => ({
      logicalReference: Arr.headNonEmpty(named).logicalReference,
      keys: Arr.dedupe(Arr.map(named, ({ key }) => key)),
    }))
  )

/** Every logical reference the copies of `record` hold, at any depth, beside the record's key. */
const logicalReferencesOf = (
  record: ImportedRecord.Type
): readonly (readonly [RecordKey.Type, LogicalReference.Type])[] =>
  record.copies.flatMap(({ resource }) =>
    Arr.filterMap(ResourceReferences.collect(resource), ({ reference }) =>
      Option.map(
        LogicalReference.tryFromReference(reference),
        (logicalReference) => [record.key, logicalReference] as const
      )
    )
  )

/**
 * The references between `records`: each record another record's logical
 * reference names, the logical references that name records, and those that
 * name none.
 *
 * @remarks
 * A record naming itself does not reference it. A reference by an identifier
 * several records carry references each of them.
 */
const of = (records: readonly ImportedRecord.Type[]): Type => {
  const named = namedRecordsOf(records)
  const recordKeysByReference = Record.fromEntries(
    named.map(({ logicalReference, keys }) => [LogicalReference.key(logicalReference), keys])
  )
  const references = records.flatMap(logicalReferencesOf)
  const namedKeysOf = (logicalReference: LogicalReference.Type): readonly RecordKey.Type[] =>
    Record.get(recordKeysByReference, LogicalReference.key(logicalReference)).pipe(
      Option.getOrElse(() => [])
    )
  return {
    referenced: HashSet.fromIterable(
      references.flatMap(([referencingKey, logicalReference]) =>
        namedKeysOf(logicalReference).filter((namedKey) => !Equal.equals(namedKey, referencingKey))
      )
    ),
    named,
    unresolved: Arr.dedupeWith(
      references
        .map(([, logicalReference]) => logicalReference)
        .filter((logicalReference) => namedKeysOf(logicalReference).length === 0),
      LogicalReference.equivalence
    ),
  }
}

/** Whether another record of the import references the record under `key`. */
const isReferenced = (recordReferences: Type, key: RecordKey.Type): boolean =>
  HashSet.has(recordReferences.referenced, key)

export { isReferenced, of }
export type { NamedRecords, Type }
