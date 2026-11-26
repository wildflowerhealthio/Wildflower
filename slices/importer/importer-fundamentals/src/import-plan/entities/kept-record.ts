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
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option, Record, Schema } from 'effect'

/**
 * One merge into the kept record: the incoming record's resource, and the
 * top-level fields taken from it.
 *
 * @remarks
 * A merge is an imported record, the incoming one, going into a record that
 * is kept. The kept record keeps its id and gains the incoming record's
 * identifiers whatever is taken; its content changes only by the fields
 * taken.
 */
interface Merge {
  readonly incoming: FhirResource
  readonly fieldsTaken: HashSet.HashSet<string>
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

const encodeIdentifier = Schema.encodeSync(IdentifierAndReference.IdentifierSchema)
const decodeStored = Schema.decodeUnknownSync(StoredResourceSchema)

/**
 * The kept record once its merges are made: its fields with each merge's
 * taken fields laid over them in order, later ones winning, and its
 * identifiers joined with every qualified identifier an incoming record
 * carries that it lacks (`IdentifierUnion.union`), under its own id.
 *
 * @throws When the result does not decode as a stored resource. It is built
 *   from decoded resources of one type, so that is a defect.
 */
const asMerged = (keptRecord: Type): FhirResourceWithId =>
  keptRecord.merges.length === 0
    ? keptRecord.kept
    : decodeStored({
        ...keptRecord.merges.reduce(
          (fields, { incoming, fieldsTaken }) => ({
            ...fields,
            ...Record.filter(fieldsOf(incoming), (_, field) => HashSet.has(fieldsTaken, field)),
          }),
          fieldsOf(keptRecord.kept)
        ),
        ...(DetachedResource.hasIdentifier(keptRecord.kept)
          ? {
              identifier: IdentifierUnion.union(
                keptRecord.kept.identifier,
                keptRecord.merges.map(({ incoming }) => incoming)
              ).map((identifier) => encodeIdentifier(identifier)),
            }
          : {}),
        id: keptRecord.kept.id,
      })

export { asMerged, of, withMerge }
export type { Type }
