/**
 * A kept record: a stored record an import merges its records into, with
 * those merges in the order they are made (`ImportedRecord.mergeOrder`).
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { encodedFieldsOf, IdentifierUnion } from '@wildflowerhealthio/fhir-r4/clients'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, HashSet, Option, Record, Schema } from 'effect'

import * as RecordChoice from './record-choice.ts'

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

/** `kept` with nothing merged into it yet. */
const of = (kept: FhirResourceWithId): Type => ({ kept, merges: [] })

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

/**
 * The kept record once its merges are made, under its own id: the last
 * edit's fields, else its own, with the taken fields of each merge after
 * that laid over them in order, later ones winning, and its identifiers
 * joined with every qualified identifier an incoming record carries that it
 * lacks.
 *
 * @throws When the result does not decode as a stored resource. It is built
 *   from decoded resources of one type, so that is a defect.
 */
const asMerged = (keptRecord: Type): FhirResourceWithId => {
  if (keptRecord.merges.length === 0) return keptRecord.kept
  const { base, fieldMerges } = baseOf(keptRecord)
  return decodeStored({
    ...fieldMerges.reduce(
      (fields, { incoming, fieldsTaken }) => ({
        ...fields,
        ...Record.filter(fieldsOf(incoming), (_, field) => HashSet.has(fieldsTaken, field)),
      }),
      fieldsOf(base)
    ),
    ...(DetachedResource.hasIdentifier(keptRecord.kept)
      ? { identifier: identifiersOf(keptRecord).map((identifier) => encodeIdentifier(identifier)) }
      : {}),
    id: keptRecord.kept.id,
  })
}

/** Whether a merge writes anything into the kept record: an edit, a taken field, or an identifier it lacks. */
const writesSomething = (keptRecord: Type): boolean =>
  keptRecord.merges.some(({ isEdit, fieldsTaken }) => isEdit || HashSet.size(fieldsTaken) > 0) ||
  identifiersOf(keptRecord).length > ownIdentifiersOf(keptRecord).length

/**
 * What is written for the kept record: the record as merged
 * ({@link asMerged}); `None` when no merge writes anything into it.
 */
const writtenOf = (keptRecord: Type): Option.Option<FhirResourceWithId> =>
  Option.map(Option.liftPredicate(keptRecord, writesSomething), asMerged)

/**
 * Each stored record the import's records merge into, as a kept record with
 * their merges so far, by its literal reference.
 */
type ByKeptRecord = HashMap.HashMap<string, Type>

/** No stored record merged into yet. */
const noneMerged: ByKeptRecord = HashMap.empty()

/**
 * `byKeptRecord` with the merge one record of the import makes after the
 * records before it, when `choice` merges into a stored record: `incoming`,
 * the record as reviewed, the fields the choice takes from it laid over that
 * kept record, or, when it is the reviewer's edit, replacing its content
 * whole. Any other choice, or none, merges nothing.
 *
 * @remarks
 * The one fold of "the records that merge into one kept record do so in
 * merge order" (`ImportedRecord.mergeOrder`): suggesting a plan folds each
 * suggestion through it, and resolving one each effective choice, both in
 * that order.
 */
const withRecordChoice = (
  byKeptRecord: ByKeptRecord,
  choice: Option.Option<RecordChoice.Type>,
  { incoming, isEdit }: Omit<Merge, 'fieldsTaken'>
): ByKeptRecord =>
  Option.match(Option.filter(choice, RecordChoice.is('MergeIntoExistingRecord')), {
    onNone: () => byKeptRecord,
    onSome: ({ existing, fieldsTaken }) =>
      HashMap.modifyAt(byKeptRecord, literalReferenceOf(existing), (keptRecord) =>
        Option.some(
          withMerge(
            Option.getOrElse(keptRecord, () => of(existing)),
            { incoming, fieldsTaken, isEdit }
          )
        )
      ),
  })

/** `existing` as merged once the records of `byKeptRecord` that merge into it have ({@link asMerged}). */
const asMergedIn = (byKeptRecord: ByKeptRecord, existing: FhirResourceWithId): FhirResourceWithId =>
  Option.match(HashMap.get(byKeptRecord, literalReferenceOf(existing)), {
    onNone: () => existing,
    onSome: asMerged,
  })

/** What is written for `existing` once the records of `byKeptRecord` that merge into it have ({@link writtenOf}). */
const writtenIn = (
  byKeptRecord: ByKeptRecord,
  existing: FhirResourceWithId
): Option.Option<FhirResourceWithId> =>
  Option.flatMap(HashMap.get(byKeptRecord, literalReferenceOf(existing)), writtenOf)

export { asMergedIn, noneMerged, withRecordChoice, writtenIn }
export type { ByKeptRecord, Merge, Type }
