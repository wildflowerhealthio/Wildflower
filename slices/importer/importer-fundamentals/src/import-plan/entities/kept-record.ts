/**
 * A changed stored record: a stored record an import uses, with the changes
 * the import's records make to it, in the order they are made
 * (`ImportedRecord.changeOrder`).
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { encodedFieldsOf, IdentifierUnion } from '@wildflowerhealthio/fhir-r4/clients'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option, Record, Schema } from 'effect'

/** One import record's change to a stored record it uses: its resource, and the top-level fields taken from it. */
interface Change {
  readonly resource: FhirResource
  readonly fieldsTaken: HashSet.HashSet<string>
}

/** A stored record beside the changes made to it, in the order they are made. */
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

const encodeIdentifier = Schema.encodeSync(IdentifierAndReference.IdentifierSchema)
const decodeStored = Schema.decodeUnknownSync(StoredResourceSchema)

/**
 * The stored record as it stands once its changes are made: its fields with
 * each change's taken fields laid over them in order, later ones winning, and
 * its identifiers joined with every qualified identifier a change's resource
 * carries that it lacks (`IdentifierUnion.union`), under its own id.
 *
 * @throws When the result does not decode as a stored resource. It is built
 *   from decoded resources of one type, so that is a defect.
 */
const asItStands = (changed: Type): FhirResourceWithId =>
  changed.changes.length === 0
    ? changed.existing
    : decodeStored({
        ...changed.changes.reduce(
          (fields, { resource, fieldsTaken }) => ({
            ...fields,
            ...Record.filter(fieldsOf(resource), (_, field) => HashSet.has(fieldsTaken, field)),
          }),
          fieldsOf(changed.existing)
        ),
        ...(DetachedResource.hasIdentifier(changed.existing)
          ? {
              identifier: IdentifierUnion.union(
                changed.existing.identifier,
                changed.changes.map(({ resource }) => resource)
              ).map((identifier) => encodeIdentifier(identifier)),
            }
          : {}),
        id: changed.existing.id,
      })

export { asItStands, of, withChange }
export type { Type }
