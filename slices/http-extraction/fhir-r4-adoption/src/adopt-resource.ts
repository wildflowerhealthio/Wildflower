import { IdentifierAndReference, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  ReferenceRewrite,
  ResourceAttachments,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option } from 'effect'

import * as DetachedResource from './detached-resource.ts'
import * as ReferencePlan from './reference-plan.ts'

/** A fresh random id for a keyless record: a v4 UUID, a legal FHIR id. */
const randomResourceId = (): string => crypto.randomUUID()

/**
 * `resource` with each `Attachment.url` that is the source URL of a record of
 * the set (`ReferencePlan.literalReferenceForSourceUrl`) pointed at the
 * literal reference that record is stored under; every other URL as it is.
 */
const adoptAttachmentUrls = <TResource extends FhirResource>(
  resource: TResource,
  referencePlan: ReferencePlan.Type
): TResource =>
  ResourceAttachments.mapUrls(resource, (url) =>
    Option.getOrElse(ReferencePlan.literalReferenceForSourceUrl(referencePlan, url), () => url)
  )

/**
 * `resource` with each of its references and attachment URLs that
 * `referencePlan` resolves made literal, still detached.
 *
 * @remarks
 * Every reference the resource carries, at any depth, is rewritten by the
 * plan's rewrite (`ReferencePlan.toRewrite`): a reference the plan resolves
 * gets the literal reference the plan gives it, `type` and `identifier`
 * kept. A logical one it does not resolve stays logical; a literal one keeps
 * its literal. Every `Attachment.url` resolves the same way
 * ({@link adoptAttachmentUrls}). Nothing else changes.
 */
const resolveReferences = <TResource extends FhirResource>(
  referencePlan: ReferencePlan.Type,
  resource: TResource
): TResource =>
  adoptAttachmentUrls(
    ReferenceRewrite.apply(resource, ReferencePlan.toRewrite(referencePlan)),
    referencePlan
  )

/**
 * Adopt a detached record into the store: give it the id it is stored under,
 * and resolve each of its references and attachment URLs the file set's
 * reference plan (`ReferencePlan.InForce`) resolves to a literal reference
 * ({@link resolveReferences}).
 *
 * @param record - The detached record
 * @param id - The id it is stored under
 * @returns Its stored form, requiring the reference plan in force
 *
 * @remarks
 * The id and the reference plan are decided before adoption, by the import
 * stage: the id a keyed record's key derives, so a re-import lands on the
 * same id, or a minted one for a keyless record. A logical reference the
 * plan does not resolve (a target the source never served, an account
 * number, a provider's printed name) stays logical, for the importer's
 * identity map. A literal one (a server's absolute URL for a `Binary` the
 * set does not hold) keeps its literal, which points at the server's
 * record. Nothing else changes: the record's identifiers, its key first, are
 * written as they are.
 *
 * Takes no base URL: everything it needs is on the records.
 */
const adopt = (
  record: DetachedResource.Type,
  id: string
): Effect.Effect<FhirResourceWithId, never, ReferencePlan.InForce> =>
  Effect.map(ReferencePlan.InForce, (referencePlan) => ({
    ...resolveReferences(referencePlan, record),
    id,
  }))

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
  identifier: DetachedResource.keyIdentifier(new URL(system), originalId),
})

export { adopt, adoptedReferenceOf, originalIdOf, randomResourceId, resolveReferences }
