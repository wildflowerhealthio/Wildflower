/**
 * Record references: what an import's records say of each other by their
 * logical references, before any is resolved.
 *
 * @packageDocumentation
 */
import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal, HashSet, Option, pipe, Record } from 'effect'

import type * as FileCopy from './imported-copy.ts'
import type * as RecordKey from './record-key.ts'

/**
 * The records of an import that another of its records references, and the
 * logical references that name no record of the import.
 */
interface Type {
  readonly referenced: HashSet.HashSet<RecordKey.Type>
  /** Each distinct logical reference naming no record of the import, in record order. */
  readonly unresolved: readonly LogicalReference.Type[]
}

/** The keys of the records each logical reference names, by `LogicalReference.key`. */
type RecordKeysByReference = Record.ReadonlyRecord<LogicalReference.Key, readonly RecordKey.Type[]>

/**
 * Each keyed record under every qualified identifier any copy of it carries.
 *
 * @remarks
 * A logical reference names a record by any of its identifiers, as a FHIR
 * conditional reference does and as `DecodedFileSet.adopt` resolves one. A
 * keyless record's identifiers name it nowhere.
 */
const recordKeysByReferenceOf = (
  records: readonly FileCopy.RecordCopies[]
): RecordKeysByReference =>
  pipe(
    records.filter(({ key }) => key._tag === 'Keyed'),
    Arr.flatMap(({ key, copies }) =>
      copies.flatMap(({ resource }) =>
        MatchQuery.qualifiedIdentifiersOf(resource).map(
          (identifier) =>
            [
              LogicalReference.key(LogicalReference.make(resource.resourceType, identifier)),
              key,
            ] as const
        )
      )
    ),
    Arr.groupBy(([referenceKey]) => referenceKey),
    Record.map((entries) => Arr.dedupe(entries.map(([, key]) => key)))
  )

/** Every logical reference the copies of `record` hold, at any depth, beside the record's key. */
const logicalReferencesOf = (
  record: FileCopy.RecordCopies
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
 * reference names, and the logical references that name none.
 *
 * @remarks
 * A record naming itself does not reference it. A reference by an identifier
 * several records carry references each of them.
 */
const of = (records: readonly FileCopy.RecordCopies[]): Type => {
  const recordKeysByReference = recordKeysByReferenceOf(records)
  const references = records.flatMap(logicalReferencesOf)
  const namedKeysOf = (logicalReference: LogicalReference.Type): readonly RecordKey.Type[] =>
    Record.get(recordKeysByReference, LogicalReference.key(logicalReference)).pipe(
      Option.getOrElse(() => [])
    )
  return {
    referenced: HashSet.fromIterable(
      references.flatMap(([referencingKey, logicalReference]) =>
        namedKeysOf(logicalReference).filter((named) => !Equal.equals(named, referencingKey))
      )
    ),
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
export type { Type }
