/**
 * A kept record: a stored record an import merges its records into, with
 * those merges in the order they are made.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { encodedFieldsOf, IdentifierUnion } from '@wildflowerhealthio/fhir-r4/clients'
import { IdentifierAndReference, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  LogicalReference,
  ResourceReferences,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashSet, Option, Record, Schema } from 'effect'

import * as ReferenceTable from './reference-table.ts'

/**
 * One merge into the kept record: the incoming record's resource, the
 * top-level fields taken from it, and whether that resource is the
 * reviewer's edit, which replaces the kept record's content whole.
 *
 * @remarks
 * A merge is an imported record, the incoming one, going into a record that
 * is kept. The kept record keeps its id and gains the incoming record's
 * identifiers whatever is taken; its content changes only by the fields
 * taken, or by an edit.
 */
interface Merge {
  readonly incoming: FhirResource
  readonly fieldsTaken: HashSet.HashSet<string>
  readonly isEdit: boolean
}

/** A kept record beside the merges into it, in the order they are made. */
interface Type {
  readonly kept: FhirResourceWithId
  readonly merges: readonly Merge[]
}

/** `kept` beside `merges`, the merges into it in the order they are made. */
const make = (kept: FhirResourceWithId, merges: readonly Merge[]): Type => ({ kept, merges })

/** `keptRecord` with `merge` made after its merges. */
const withMerge = (keptRecord: Type, merge: Merge): Type => ({
  ...keptRecord,
  merges: [...keptRecord.merges, merge],
})

/**
 * `resource`'s every top-level field as its schema encodes it.
 *
 * @throws When `resource` does not encode through its own schema. Every
 *   resource here was decoded by that schema, so that is a defect.
 */
const fieldsOf = (resource: FhirResource): Record.ReadonlyRecord<string, unknown> =>
  Option.getOrThrowWith(
    encodedFieldsOf(resource),
    () => new Error(`A decoded ${resource.resourceType} does not encode through its schema`)
  )

/**
 * The resource the kept record's fields start from, and the merges that take
 * fields over it: the last edit and the merges after it, else the kept
 * record itself and every merge.
 */
const baseOf = (
  keptRecord: Type
): { readonly base: FhirResource; readonly fieldMerges: readonly Merge[] } =>
  Option.match(
    Arr.findLastIndex(keptRecord.merges, ({ isEdit }) => isEdit),
    {
      onNone: () => ({ base: keptRecord.kept, fieldMerges: keptRecord.merges }),
      onSome: (lastEdit) => ({
        base: Arr.unsafeGet(keptRecord.merges, lastEdit).incoming,
        fieldMerges: keptRecord.merges.slice(lastEdit + 1),
      }),
    }
  )

/** The kept record's own identifiers; none for a type with no `identifier` element. */
const ownIdentifiersOf = (keptRecord: Type): readonly IdentifierAndReference.IdentifierType[] =>
  DetachedResource.hasIdentifier(keptRecord.kept) ? keptRecord.kept.identifier : []

/**
 * The kept record's identifiers once its merges are made: its own, then each
 * qualified identifier an incoming record carries that they lack
 * (`IdentifierUnion.union`).
 */
const identifiersOf = (keptRecord: Type): readonly IdentifierAndReference.IdentifierType[] =>
  IdentifierUnion.union(
    ownIdentifiersOf(keptRecord),
    keptRecord.merges.map(({ incoming }) => incoming)
  )

const encodeIdentifier = Schema.encodeSync(IdentifierAndReference.IdentifierSchema)
const decodeStored = Schema.decodeUnknownSync(StoredResourceSchema)

/** The fields `merge` takes from its incoming record, as that record's schema encodes them. */
const takenFieldsOf = ({ incoming, fieldsTaken }: Merge): Record.ReadonlyRecord<string, unknown> =>
  Record.filter(fieldsOf(incoming), (_, field) => HashSet.has(fieldsTaken, field))

/** `fields` with the fields `merge` takes laid over them ({@link takenFieldsOf}). */
const withTakenFields = (
  fields: Record.ReadonlyRecord<string, unknown>,
  merge: Merge
): Record.ReadonlyRecord<string, unknown> => ({ ...fields, ...takenFieldsOf(merge) })

/**
 * The kept record once its merges are made, under its own id: the last
 * edit's fields, else its own, with the taken fields of each merge after
 * that laid over them in order, later ones winning
 * ({@link withTakenFields}), and its identifiers joined with every qualified
 * identifier an incoming record carries that it lacks.
 *
 * @throws When the result does not decode as a stored resource. It is built
 *   from decoded resources of one type, so that is a defect.
 */
const asMerged = (keptRecord: Type): FhirResourceWithId => {
  if (keptRecord.merges.length === 0) return keptRecord.kept
  const { base, fieldMerges } = baseOf(keptRecord)
  return decodeStored({
    ...Arr.reduce(fieldMerges, fieldsOf(base), withTakenFields),
    ...(DetachedResource.hasIdentifier(keptRecord.kept)
      ? { identifier: identifiersOf(keptRecord).map((identifier) => encodeIdentifier(identifier)) }
      : {}),
    id: keptRecord.kept.id,
  })
}

/** Whether a merge writes anything into the kept record: an edit, a taken field, or an identifier it lacks. */
const mergesWriteSomething = (keptRecord: Type): boolean =>
  keptRecord.merges.some(({ isEdit, fieldsTaken }) => isEdit || HashSet.size(fieldsTaken) > 0) ||
  identifiersOf(keptRecord).length > ownIdentifiersOf(keptRecord).length

/**
 * The literal `table` lands `reference` on when `reference` is unlinked: it
 * names its target by a type and a qualified identifier alone, with no
 * literal (`LogicalReference.tryFromReference`). `None` for any other
 * reference, and for an unlinked one the table lands on a stub or nowhere.
 */
const linkFor = (table: ReferenceTable.Type, reference: ReferenceType): Option.Option<string> =>
  Option.flatMap(LogicalReference.tryFromReference(reference), (logicalReference) =>
    ReferenceTable.literalReferenceFor(table, logicalReference)
  )

/** Whether `table` links a reference of `resource`: one of its unlinked references lands on a literal ({@link linkFor}). */
const gainsLink = (table: ReferenceTable.Type, resource: FhirResourceWithId): boolean =>
  ResourceReferences.collect(resource).some(({ reference }) =>
    Option.isSome(linkFor(table, reference))
  )

/**
 * `resource` with each of its unlinked references given the literal `table`
 * lands it on ({@link linkFor}), keeping its `type`, `identifier` and
 * `display`; every other reference as it is. So the links are completed and
 * nothing the stored record says is replaced.
 */
const withLinksLanded = (
  table: ReferenceTable.Type,
  resource: FhirResourceWithId
): FhirResourceWithId =>
  ResourceReferences.mapReferences(resource, (reference) =>
    Option.match(linkFor(table, reference), {
      onNone: () => reference,
      onSome: (literalReference) => ({ ...reference, reference: literalReference }),
    })
  )

/**
 * What is written for the kept record: the record as merged
 * ({@link asMerged}) with its links landed by `table`
 * ({@link withLinksLanded}); `None` when no merge writes anything into it
 * and no reference gains its link.
 *
 * @remarks
 * Links are always added, as identifiers are: whatever fields its merges
 * take, a kept record is linked to the records and stored records its
 * unlinked references land on. A display alone writes nothing.
 */
const writtenOf = (
  table: ReferenceTable.Type,
  keptRecord: Type
): Option.Option<FhirResourceWithId> => {
  const merged = asMerged(keptRecord)
  const isWritten = mergesWriteSomething(keptRecord) || gainsLink(table, merged)
  return isWritten ? Option.some(withLinksLanded(table, merged)) : Option.none()
}

export { asMerged, make, withMerge, writtenOf }
export type { Merge, Type }
