/**
 * A changed stored record: a stored record an import uses, with the changes
 * the import's records make to it, in plan order.
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
 * One import record's change to a stored record it uses: its resource, the
 * top-level fields taken from it, and whether the resource is the reviewer's
 * edit, which replaces the stored record whole.
 */
interface Change {
  readonly resource: FhirResource
  readonly fieldsTaken: HashSet.HashSet<string>
  readonly isEdit: boolean
}

/** A stored record beside the changes made to it, in plan order. */
interface Type {
  readonly existing: FhirResourceWithId
  readonly changes: readonly Change[]
}

/** `existing` with no change yet. */
const of = (existing: FhirResourceWithId): Type => ({ existing, changes: [] })

/** `changed` with `change` made after its changes. */
const withChange = (changed: Type, change: Change): Type => ({
  ...changed,
  changes: [...changed.changes, change],
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
 * The resource the record's fields start from, and the changes that take
 * fields over it: the last edit and the changes after it, else the stored
 * record and every change.
 */
const baseOf = (
  changed: Type
): { readonly base: FhirResource; readonly fieldChanges: readonly Change[] } =>
  Option.match(
    Arr.findLastIndex(changed.changes, ({ isEdit }) => isEdit),
    {
      onNone: () => ({ base: changed.existing, fieldChanges: changed.changes }),
      onSome: (lastEdit) => ({
        base: Arr.unsafeGet(changed.changes, lastEdit).resource,
        fieldChanges: changed.changes.slice(lastEdit + 1),
      }),
    }
  )

/** The stored record's own identifiers; none for a type with no `identifier` element. */
const ownIdentifiersOf = (changed: Type): readonly IdentifierAndReference.IdentifierType[] =>
  DetachedResource.hasIdentifier(changed.existing) ? changed.existing.identifier : []

/**
 * The record's identifiers once its changes are made: the stored record's,
 * then each qualified identifier a change's resource carries that they lack
 * (`IdentifierUnion.union`).
 */
const identifiersOf = (changed: Type): readonly IdentifierAndReference.IdentifierType[] =>
  IdentifierUnion.union(
    ownIdentifiersOf(changed),
    changed.changes.map(({ resource }) => resource)
  )

const encodeIdentifier = Schema.encodeSync(IdentifierAndReference.IdentifierSchema)
const decodeStored = Schema.decodeUnknownSync(StoredResourceSchema)

/**
 * The stored record as it stands once its changes are made, under its own
 * id: the last edit's fields, else its own, with the taken fields of each
 * change after that laid over them in order, later ones winning, and its
 * identifiers joined with every qualified identifier a change's resource
 * carries that it lacks.
 *
 * @throws When the result does not decode as a stored resource. It is built
 *   from decoded resources of one type, so that is a defect.
 */
const asItStands = (changed: Type): FhirResourceWithId => {
  if (changed.changes.length === 0) return changed.existing
  const { base, fieldChanges } = baseOf(changed)
  return decodeStored({
    ...fieldChanges.reduce(
      (fields, { resource, fieldsTaken }) => ({
        ...fields,
        ...Record.filter(fieldsOf(resource), (_, field) => HashSet.has(fieldsTaken, field)),
      }),
      fieldsOf(base)
    ),
    ...(DetachedResource.hasIdentifier(changed.existing)
      ? { identifier: identifiersOf(changed).map((identifier) => encodeIdentifier(identifier)) }
      : {}),
    id: changed.existing.id,
  })
}

/** Whether a change writes anything into the stored record: an edit, a taken field, or an identifier it lacks. */
const changesSomething = (changed: Type): boolean =>
  changed.changes.some(({ isEdit, fieldsTaken }) => isEdit || HashSet.size(fieldsTaken) > 0) ||
  identifiersOf(changed).length > ownIdentifiersOf(changed).length

/**
 * What is written for the stored record: the record as it stands
 * ({@link asItStands}); `None` when no change writes anything into it.
 */
const writtenOf = (changed: Type): Option.Option<FhirResourceWithId> =>
  Option.map(Option.liftPredicate(changed, changesSomething), asItStands)

/**
 * Each stored record the import's records use, with their changes so far,
 * by its literal reference.
 */
type ByStoredRecord = HashMap.HashMap<string, Type>

/** No stored record changed yet. */
const noneChanged: ByStoredRecord = HashMap.empty()

/**
 * `byStoredRecord` with the change one record of the import makes after the
 * records before it, when `choice` uses a stored record: `resource`, the
 * record as reviewed, the fields the choice takes from it laid over that
 * stored record, or, when it is the reviewer's edit, replacing it whole.
 * Any other choice, or none, changes nothing.
 *
 * @remarks
 * The one fold of "the records that use one stored record change it in
 * plan order": suggesting a plan folds each suggestion through it, and
 * resolving one each effective choice.
 */
const withRecordChoice = (
  byStoredRecord: ByStoredRecord,
  choice: Option.Option<RecordChoice.Type>,
  { resource, isEdit }: Omit<Change, 'fieldsTaken'>
): ByStoredRecord =>
  Option.match(Option.filter(choice, RecordChoice.is('UseExistingRecord')), {
    onNone: () => byStoredRecord,
    onSome: ({ existing, fieldsTaken }) =>
      HashMap.modifyAt(byStoredRecord, literalReferenceOf(existing), (changed) =>
        Option.some(
          withChange(
            Option.getOrElse(changed, () => of(existing)),
            { resource, fieldsTaken, isEdit }
          )
        )
      ),
  })

/** `existing` as it stands once the records of `byStoredRecord` that use it change it ({@link asItStands}). */
const asItStandsIn = (
  byStoredRecord: ByStoredRecord,
  existing: FhirResourceWithId
): FhirResourceWithId =>
  Option.match(HashMap.get(byStoredRecord, literalReferenceOf(existing)), {
    onNone: () => existing,
    onSome: asItStands,
  })

/** What is written for `existing` once the records of `byStoredRecord` that use it change it ({@link writtenOf}). */
const writtenIn = (
  byStoredRecord: ByStoredRecord,
  existing: FhirResourceWithId
): Option.Option<FhirResourceWithId> =>
  Option.flatMap(HashMap.get(byStoredRecord, literalReferenceOf(existing)), writtenOf)

export { asItStandsIn, noneChanged, withRecordChoice, writtenIn }
export type { ByStoredRecord, Change, Type }
