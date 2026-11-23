/**
 * Record references: what an import's records say of each other by their
 * logical references, before any is resolved.
 *
 * @packageDocumentation
 */
import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Equal, HashSet, Option, pipe, Record } from 'effect'

import * as ImportedRecord from './imported-record.ts'
import * as RecordKey from './record-key.ts'

/**
 * The records of an import that another of its records references, and the
 * logical references that match no record of the import.
 */
interface Type {
  readonly referenced: HashSet.HashSet<RecordKey.Type>
  /** Each distinct logical reference matching no record of the import, in record order. */
  readonly unresolved: readonly LogicalReference.Type[]
}

/**
 * The records each logical reference matches, by `LogicalReference.key`: those
 * a copy of which carries its identifier under its type.
 */
type MatchingRecordsByReference = Record.ReadonlyRecord<
  LogicalReference.Key,
  readonly ImportedRecord.Type[]
>

/**
 * Each record with a key identifier under every qualified identifier any
 * copy of it carries, each record once under each.
 *
 * @remarks
 * A logical reference matches a record by any of its identifiers, as a FHIR
 * conditional reference does and as `DecodedFileSet.adopt` resolves one. The
 * identifiers of a record with no key identifier match it nowhere, whether it
 * is keyed by its source URL or by its review key.
 */
const matchingRecordsByReferenceOf = (
  records: readonly ImportedRecord.Type[]
): MatchingRecordsByReference =>
  pipe(
    records.filter(({ key }) => RecordKey.isKeyed(key)),
    Arr.flatMap((record) =>
      record.copies.flatMap(({ resource }) =>
        MatchQuery.qualifiedIdentifiersOf(resource).map(
          (identifier) =>
            [
              LogicalReference.key(LogicalReference.make(resource.resourceType, identifier)),
              record,
            ] as const
        )
      )
    ),
    Arr.groupBy(([referenceKey]) => referenceKey),
    Record.map((entries) =>
      Arr.dedupeWith(
        entries.map(([, record]) => record),
        (a, b) => Equal.equals(a.key, b.key)
      )
    )
  )

/**
 * The key of the record of the import `logicalReference` names, among the
 * records it matches (`matching`); `None` when it names none of them.
 *
 * @remarks
 * A decoded record beats an implied one: when any match has a decoded copy,
 * the matches whose every copy is implied are out (`ImportedRecord.isImplied`).
 * Among those left, the record keyed by the reference's own identifier wins;
 * else the one left is named. Several left, none keyed by it, name none: the
 * reference stays logical until two imported records can be merged (#1470).
 */
const recordKeyIfNamed = (
  matching: readonly ImportedRecord.Type[],
  logicalReference: LogicalReference.Type
): Option.Option<RecordKey.Type> => {
  const decoded = matching.filter((record) => !ImportedRecord.isImplied(record))
  const contenders = decoded.length > 0 ? decoded : matching
  const keyedByReference = RecordKey.fromLogicalReference(logicalReference)
  return pipe(
    Arr.findFirst(contenders, ({ key }) => Equal.equals(key, keyedByReference)),
    Option.orElse(() => onlyElement(contenders)),
    Option.map(({ key }) => key)
  )
}

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
 * reference names ({@link recordKeyIfNamed}), and the logical references that
 * match none.
 *
 * @remarks
 * A record naming itself does not reference it. A reference that matches
 * several records and names none of them is not unresolved: it names no
 * stored record either.
 */
const of = (records: readonly ImportedRecord.Type[]): Type => {
  const matchingRecordsByReference = matchingRecordsByReferenceOf(records)
  const references = records.flatMap(logicalReferencesOf)
  const matchingRecordsOf = (
    logicalReference: LogicalReference.Type
  ): readonly ImportedRecord.Type[] =>
    Record.get(matchingRecordsByReference, LogicalReference.key(logicalReference)).pipe(
      Option.getOrElse(() => [])
    )
  return {
    referenced: HashSet.fromIterable(
      Arr.filterMap(references, ([referencingKey, logicalReference]) =>
        Option.filter(
          recordKeyIfNamed(matchingRecordsOf(logicalReference), logicalReference),
          (named) => !Equal.equals(named, referencingKey)
        )
      )
    ),
    unresolved: Arr.dedupeWith(
      references
        .map(([, logicalReference]) => logicalReference)
        .filter((logicalReference) => matchingRecordsOf(logicalReference).length === 0),
      LogicalReference.equivalence
    ),
  }
}

/** Whether another record of the import references the record under `key`. */
const isReferenced = (recordReferences: Type, key: RecordKey.Type): boolean =>
  HashSet.has(recordReferences.referenced, key)

export { isReferenced, of }
export type { Type }
