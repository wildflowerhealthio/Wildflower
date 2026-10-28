/**
 * Resolving a decoded file on its batch's link plan: each decoded resource
 * written as the resource the plan has for it, with its mentions redirected to
 * their referents' link targets; and the records the batch only mentions, as
 * the batch's own linked records. Every function takes the plan first, since
 * it is fixed for a batch.
 *
 * @packageDocumentation
 */

import { type FhirResourceWithId, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, HashMap, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'

/**
 * A record the batch only mentions, as it will be written, with where it
 * comes from: a `Stored` resource the device already holds, or a
 * `Provisional` one the map makes from a logical reference alone.
 */
type LinkedRecord = DecodedFile.Resource & { readonly origin: 'Stored' | 'Provisional' }

/** The review key a resource the batch only mentions is reviewed under, among the batch's linked records. */
const linkedKey = (onlyMentioned: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalReferenceOf(onlyMentioned)}`

/**
 * `mentioningResource` with every reference it carries that `plan` redirects
 * pointed at its referent's link target, keeping its `display` and its own
 * `identifier`. Walks every reference, not only the mention fields, so a
 * provider named elsewhere moves too. The same object when nothing moves.
 */
const redirectMentions =
  (plan: LinkPlan.Type) =>
  (mentioningResource: FhirResourceWithId): FhirResourceWithId =>
    ResourceReferences.mapReferences(mentioningResource, (referenceAsDecoded) =>
      Option.match(LinkPlan.redirectionIfLinked(plan, referenceAsDecoded), {
        onNone: () => referenceAsDecoded,
        onSome: (resolvedLiteralReference) => ({
          ...referenceAsDecoded,
          reference: resolvedLiteralReference,
        }),
      })
    )

/** Whether `after` holds the very resource and title `before` does. */
const sameEntry = (before: DecodedFile.Resource, after: DecodedFile.Resource): boolean =>
  after.resource === before.resource && after.title === before.title

/**
 * `decodedEntry` as it is resolved under `plan`: a referent's resource
 * written as its resolved resource (a stored resource standing in for it, or
 * itself having assumed what the referents linked to it bring), any other
 * written as decoded, with its mentions redirected either way. An entry whose
 * resource the resolved one replaces under another id takes the resolved
 * resource's label as its title; any other keeps its own. The same object
 * when nothing changes.
 */
const resolveEntry =
  (plan: LinkPlan.Type) =>
  (decodedEntry: DecodedFile.Resource): DecodedFile.Resource => {
    const resolvedEntry = Option.match(
      LinkPlan.resolvedResourceIfReferent(plan, decodedEntry.resource),
      {
        onNone: () => ({
          ...decodedEntry,
          resource: redirectMentions(plan)(decodedEntry.resource),
        }),
        onSome: (resolvedResource) => ({
          ...decodedEntry,
          resource: redirectMentions(plan)(resolvedResource.resource),
          title:
            resolvedResource.resource.id === decodedEntry.resource.id
              ? decodedEntry.title
              : resolvedResource.label,
        }),
      }
    )
    return sameEntry(decodedEntry, resolvedEntry) ? decodedEntry : resolvedEntry
  }

/**
 * The linked record `target`'s resource is under `plan`, keyed by
 * {@link linkedKey}, titled by its label and with the target's tag as its
 * origin, when the batch only mentions it; `None` when a resolved file holds
 * it where a decoded resource was.
 */
const linkedRecordIfOnlyMentioned =
  (plan: LinkPlan.Type) =>
  (target: LinkTarget.StoredType | LinkTarget.ProvisionalType): Option.Option<LinkedRecord> =>
    HashMap.get(
      plan.resolvedResourcesByResolvedLiteralReference,
      LinkableResource.literalReferenceOf(target.resource)
    ).pipe(
      Option.filter((resolvedResource) => !resolvedResource.resourceExistsInBatch),
      Option.map(({ resource, label }) => ({
        key: linkedKey(resource),
        title: label,
        resource,
        origin: target._tag,
      }))
    )

/**
 * The batch's linked records under `plan`: the records it only mentions, as
 * they will be written, in the order their referents were discovered. Only a
 * `Stored` or `Provisional` target can be one: a `Decoded` target's resource
 * is always in the batch, and an `Unlinked` one holds none. No resolved file
 * holds them; they are the batch's own, reviewed and written beside the
 * files.
 */
const linkedRecords = (plan: LinkPlan.Type): readonly LinkedRecord[] =>
  pipe(
    plan.links,
    Array.filterMap(
      ({ target }): Option.Option<LinkTarget.StoredType | LinkTarget.ProvisionalType> =>
        LinkTarget.match(target, {
          Stored: Option.some,
          Provisional: Option.some,
          Decoded: Option.none,
          Unlinked: Option.none,
        })
    ),
    Array.dedupeWith((left, right) => LinkableResource.sameRecord(left.resource, right.resource)),
    Array.filterMap(linkedRecordIfOnlyMentioned(plan))
  )

/**
 * `decodedFile` resolved on `plan`: the file to review, diff and write. Every
 * section keeps its keys, and an entry nothing changed in comes back as the
 * same object. The records the batch only mentions are no file's: they are
 * {@link linkedRecords}.
 */
const resolveFile =
  (plan: LinkPlan.Type) =>
  (decodedFile: DecodedFile.DecodedFile): DecodedFile.DecodedFile =>
    DecodedFile.mapResources(decodedFile, resolveEntry(plan))

export { linkedKey, linkedRecords, resolveFile }
export type { LinkedRecord }
