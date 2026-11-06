import { IdentifierAndReference, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import * as DetachedResource from './detached-resource.ts'
import * as ReferencePlan from './reference-plan.ts'
import { identifierOf, mapAttachmentUrls, mapReferences } from './reference-table.ts'

/** A fresh random id for a keyless record: a v4 UUID, a legal FHIR id. */
const randomResourceId = (): string => crypto.randomUUID()

/**
 * A reference the batch's reference plan resolves, as the literal reference
 * the plan gives it, `type` and `identifier` kept; every other reference
 * exactly as it is.
 *
 * @remarks
 * Resolved by `ReferencePlan.literalReferenceIfResolved`: a logical
 * reference by its type and identifier, a literal one (a server's absolute
 * URL for a `Binary`) by an entry's `fullUrl`. A logical one the plan does
 * not resolve — a target the source never served, an account number, a
 * provider's printed name — stays logical, for the importer's identity map
 * (and, later, a match against what the device already holds); a literal one
 * keeps its literal, which points at the server's record.
 */
const adoptReference =
  (referencePlan: ReferencePlan.Type) =>
  (reference: ReferenceType): ReferenceType =>
    Option.match(ReferencePlan.literalReferenceIfResolved(referencePlan, reference), {
      onSome: (literalReference) => ({ ...reference, reference: literalReference }),
      onNone: () => reference,
    })

/**
 * An `Attachment.url` that is the `fullUrl` of a record of the batch, as the
 * literal reference that record is stored under; every other URL exactly as
 * it is.
 */
const adoptAttachmentUrl =
  (referencePlan: ReferencePlan.Type) =>
  (url: string): string =>
    Option.getOrElse(ReferencePlan.literalReferenceForFullUrl(referencePlan, url), () => url)

/**
 * Adopt a detached record into the store: give it the id it is stored under,
 * and resolve each of its references and attachment URLs the batch's
 * reference plan resolves to a literal reference.
 *
 * @param referencePlan - The literal reference each logical reference into
 *   the batch resolves to
 * @returns A function from one detached record and the id it is stored under
 *   to its stored form
 *
 * @remarks
 * The id and the reference plan are decided before adoption, by the import
 * stage: the id a keyed record's key derives, so a re-import lands on the
 * same id, or a minted one for a keyless record. References resolve through
 * {@link adoptReference}, attachment URLs through {@link adoptAttachmentUrl}.
 * Nothing else changes: the record's identifiers, its key first, are written
 * as they are.
 *
 * Takes no base URL: everything it needs is on the records.
 */
const adopt = (referencePlan: ReferencePlan.Type) => {
  const adoptReferences = mapReferences(adoptReference(referencePlan))
  const adoptAttachmentUrls = mapAttachmentUrls(adoptAttachmentUrl(referencePlan))
  return (record: DetachedResource.Type, id: string): FhirResourceWithId => ({
    ...adoptAttachmentUrls(adoptReferences(record)),
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
