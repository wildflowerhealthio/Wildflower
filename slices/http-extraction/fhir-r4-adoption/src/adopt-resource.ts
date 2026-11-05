import { IdentifierAndReference, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  ResourceType,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import * as DetachedResource from './detached-resource.ts'
import { identifierOf, mapReferences } from './reference-table.ts'

/** A fresh random id for a keyless record: a v4 UUID, a legal FHIR id. */
const randomResourceId = (): string => crypto.randomUUID()

/**
 * The literal reference the record of `resourceType` keyed by `key` is stored
 * under, when it is a record of the batch being adopted; `None` otherwise.
 *
 * @remarks
 * The batch's id plan answers it: the import stage decides every record's id
 * before it adopts any, so this is a lookup of an id already decided, not a
 * derivation.
 */
type ReferenceTo = (resourceType: string, key: DetachedResource.Key) => Option.Option<string>

/**
 * A logical reference to a record of the batch, as the literal reference
 * `referenceTo` gives that record, `type` and `identifier` kept; every other
 * reference exactly as it is.
 *
 * @remarks
 * As a FHIR server resolves a conditional reference against the transaction
 * bundle it processes: a reference with no literal, an R4 resource type as
 * its `type`, and an `identifier` with a `system` and `value` resolves when
 * the record of that type keyed by that identifier is in the batch. One that
 * matches no record of the batch — a target the source never served, an
 * account number, a provider's printed name — stays logical, for the
 * importer's identity map (and, later, a match against what the device
 * already holds). A reference whose target is keyless cannot name it, so it
 * stays logical too.
 */
const adoptReference =
  (referenceTo: ReferenceTo) =>
  (reference: ReferenceType): ReferenceType => {
    const { identifier, type } = reference
    if (
      reference.reference !== null ||
      type === null ||
      !ResourceType.is(type) ||
      identifier === null ||
      !IdentifierAndReference.isQualifiedIdentifier(identifier)
    ) {
      return reference
    }
    return Option.match(
      referenceTo(type, { system: identifier.system.href, value: identifier.value }),
      {
        onSome: (stored) => ({ ...reference, reference: stored }),
        onNone: () => reference,
      }
    )
  }

/**
 * Adopt a detached record into the store: give it the id it is stored under,
 * and resolve each of its logical references to a record of the batch to a
 * literal one.
 *
 * @param referenceTo - The literal reference each record of the batch is
 *   stored under, by type and key
 * @returns A function from one detached record and the id it is stored under
 *   to its stored form
 *
 * @remarks
 * The id is decided before adoption, by the import stage's id plan: the id a
 * keyed record's key derives, so a re-import lands on the same id, or a
 * minted one for a keyless record. References resolve through
 * {@link adoptReference}. Nothing else changes: the record's identifiers,
 * its key first, are written as they are.
 *
 * Takes no base URL: everything it needs is on the records.
 */
const adopt = (referenceTo: ReferenceTo) => {
  const adoptReferences = mapReferences(adoptReference(referenceTo))
  return (record: DetachedResource.Type, id: string): FhirResourceWithId => ({
    ...adoptReferences(record),
    id,
  })
}

/**
 * The id a source gave an adopted resource: the value of its identifier in
 * `system`.
 *
 * @param system - The system the source's ids for the type belong to: for a
 *   FHIR server `<baseUrl>/<Type>`, not the base itself
 * @param resource - The adopted resource
 * @returns The first identifier value in `system`, or `null` when it has none
 *   there (and always for a `Binary`, which has no identifiers)
 *
 * @remarks
 * What a caller reads when it needs the source's id to build a source-server
 * URL: an adopted resource's `resource.id` is the local id, not the remote
 * one.
 */
const originalIdOf = (system: string, resource: FhirResource): string | null =>
  DetachedResource.hasIdentifier(resource)
    ? (resource.identifier.find((identifier) => identifier.system?.href === system)?.value ?? null)
    : null

/**
 * The literal reference a source's import stores the record keyed
 * `{ system, value: originalId }` under, beside the logical reference to it:
 * `reference` its stored reference ({@link DetachedResource.storedReferenceOf}),
 * `type` and `identifier` the key.
 *
 * @param system - The system the source's ids for the target's type belong
 *   to: for a FHIR server `<baseUrl>/<Type>`, not the base itself
 * @param resourceType - The target's type (`Patient`)
 * @param originalId - The id the source gave the target
 *
 * @remarks
 * For a resource written outside that source that has to point at what its
 * import stores — a lab result filed on the Patient a pharmacy import made.
 * It is the spelling {@link adopt} gives a resolved reference, with nothing
 * to resolve against: the caller states that the record is stored.
 */
const adoptedReferenceOf = (
  system: string,
  resourceType: string,
  originalId: string
): ReferenceType => ({
  ...IdentifierAndReference.emptyReference,
  reference: DetachedResource.storedReferenceOf(resourceType, { system, value: originalId }),
  type: resourceType,
  identifier: identifierOf(new URL(system), originalId),
})

export { adopt, adoptedReferenceOf, originalIdOf, randomResourceId }
export type { ReferenceTo }
