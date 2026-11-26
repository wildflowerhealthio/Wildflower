/**
 * Comparable references: an import record's and a stored record's references
 * read so that two naming one record compare equal, whatever literal each
 * carries.
 *
 * @packageDocumentation
 */
import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  literalReferenceOf,
  LogicalReference,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, HashMap, Option, pipe, Record } from 'effect'

import * as ImportedCopy from '../../entities/imported-copy.ts'
import * as ImportedRecord from '../../entities/imported-record.ts'
import * as StoredMatch from '../../entities/stored-match.ts'

/**
 * For each literal reference that names a record of the import, the literal
 * the record is compared by: its stage literal (`ImportedRecord.stageLiteralOf`).
 *
 * @remarks
 * A record is named by the stage literal of each of its copies
 * (`ImportedCopy.stageLiteralOf`, how a format's hooks name it in that
 * copy's file set; a record keyed by its source URL has one per file set)
 * and by the literal of each of its stored copies
 * (`StoredMatch.storedCopiesOf`). A literal several records claim names none
 * of them.
 */
interface Type {
  readonly recordLiterals: HashMap.HashMap<string, string>
}

/** The comparable references of `records`, each record's stored copies read off `storedMatch`. */
const of = (records: readonly ImportedRecord.Type[], storedMatch: StoredMatch.Type): Type =>
  pipe(
    records.flatMap((record) => {
      const recordLiteral = ImportedRecord.stageLiteralOf(record)
      return [
        ...record.copies.map(ImportedCopy.stageLiteralOf),
        ...StoredMatch.storedCopiesOf(StoredMatch.ofRecord(storedMatch, record.key)).map(
          literalReferenceOf
        ),
      ].map((literal) => [literal, recordLiteral] as const)
    }),
    Arr.groupBy(([literal]) => literal),
    Record.toEntries,
    Arr.filterMap(([literal, named]) =>
      Option.map(
        onlyElement(Arr.dedupe(named.map(([, recordLiteral]) => recordLiteral))),
        (recordLiteral) => [literal, recordLiteral] as const
      )
    ),
    HashMap.fromIterable,
    (recordLiterals) => ({ recordLiterals })
  )

/** Whether `reference` names its target by a type and a qualified identifier. */
const namesByIdentifier = (reference: ReferenceType): boolean =>
  Option.isSome(LogicalReference.tryFromReference({ ...reference, reference: null }))

/**
 * `reference` with its literal as it is compared: one naming its target by a
 * type and a qualified identifier without its literal, so a stored copy's and
 * an import record's agree; one naming a record of the import by a literal
 * alone, by the record's literal ({@link Type}); any other as it is.
 */
const comparableTargetOf = (comparable: Type, reference: ReferenceType): ReferenceType =>
  namesByIdentifier(reference)
    ? { ...reference, reference: null }
    : pipe(
        Option.fromNullable(reference.reference),
        Option.flatMap((literal) => HashMap.get(comparable.recordLiterals, literal)),
        Option.match({
          onNone: () => reference,
          onSome: (recordLiteral) => ({ ...reference, reference: recordLiteral }),
        })
      )

/**
 * `reference` as it is compared: its target as {@link comparableTargetOf}
 * reads it, without its `display` when it names its target by a literal or by
 * a type and a qualified identifier.
 *
 * @remarks
 * FHIR's `display` is a text alternative to the reference, not what it points
 * at, so a stub written with a display the import's copy lacks is the same
 * reference. A reference that is only a display is compared by it.
 */
const comparableReferenceOf = (comparable: Type, reference: ReferenceType): ReferenceType => {
  const target = comparableTargetOf(comparable, reference)
  return target.reference !== null || namesByIdentifier(reference)
    ? { ...target, display: null }
    : target
}

/** `resource` with every reference as it is compared ({@link comparableReferenceOf}). */
const comparableResourceOf = <TResource extends FhirResource>(
  comparable: Type,
  resource: TResource
): TResource =>
  ResourceReferences.mapReferences(resource, (reference) =>
    comparableReferenceOf(comparable, reference)
  )

export { comparableResourceOf, of }
export type { Type }
