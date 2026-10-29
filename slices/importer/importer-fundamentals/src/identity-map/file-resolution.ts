/**
 * Resolving a decoded file on its batch's link plan: each decoded resource
 * written as the resource the plan has for it, with its mentions redirected to
 * their referents' link targets, or redirected where the reviewer chose for one
 * on its own; and the records the batch only mentions, as the batch's own
 * linked records. Every function takes the plan first, since it is fixed for
 * a batch.
 *
 * @packageDocumentation
 */

import { type FhirResourceWithId, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Mention from './mention.ts'

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
const redirectToReferentLinkTargets =
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

/**
 * `mentioningResource`, reviewed under `reviewKey`, with each mention the
 * reviewer chose a link for on its own redirected where that choice says
 * (`Mention.relinked`): on the chosen resource's literal reference, or, for
 * `Unlinked`, with its literal dropped, which changes nothing when the
 * mention would then name nothing. An empty `subject` slot chosen for is
 * filled. The same object when no mention is chosen for.
 */
const redirectChosenMentions =
  (plan: LinkPlan.Type, reviewKey: string) =>
  (mentioningResource: FhirResourceWithId): FhirResourceWithId =>
    Mention.linkableIn(mentioningResource).reduce(
      (redirected, mention) =>
        Option.match(LinkPlan.linkTargetIfChosenForMention(plan, reviewKey, mention), {
          onNone: () => redirected,
          onSome: (target) =>
            Mention.relinked(
              redirected,
              mention.path,
              Option.map(LinkTarget.resourceIfLinked(target), LinkableResource.literalReferenceOf)
            ),
        }),
      mentioningResource
    )

/**
 * `mentioningResource`, reviewed under `reviewKey`, with every mention
 * redirected: each the reviewer chose a link for on its own where that choice
 * says, over every other redirected to its referent's link target. The same
 * object when nothing moves.
 */
const redirectMentions =
  (plan: LinkPlan.Type, reviewKey: string) =>
  (mentioningResource: FhirResourceWithId): FhirResourceWithId =>
    pipe(
      mentioningResource,
      redirectToReferentLinkTargets(plan),
      redirectChosenMentions(plan, reviewKey)
    )

/** Whether `after` holds the very resource and title `before` does. */
const sameEntry = (before: DecodedFile.Resource, after: DecodedFile.Resource): boolean =>
  after.resource === before.resource && after.title === before.title

/**
 * `decodedEntry` as it is resolved under `plan`: a referent's resource
 * written as its resolved resource (a stored resource standing in for it, or
 * itself having assumed what the referents linked to it bring), any other
 * written as decoded, with its mentions redirected either way, those the
 * reviewer chose a link for under the entry's review key where their choice
 * says. An entry whose resource the resolved one replaces under another id
 * takes the resolved resource's label as its title; any other keeps its own.
 * The same object when nothing changes.
 */
const resolveEntry =
  (plan: LinkPlan.Type) =>
  (decodedEntry: DecodedFile.Resource): DecodedFile.Resource => {
    const redirect = redirectMentions(plan, decodedEntry.key)
    const resolvedEntry = Option.match(
      LinkPlan.resolvedResourceIfReferent(plan, decodedEntry.resource),
      {
        onNone: () => ({
          ...decodedEntry,
          resource: redirect(decodedEntry.resource),
        }),
        onSome: (resolvedResource) => ({
          ...decodedEntry,
          resource: redirect(resolvedResource.resource),
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
 * The batch's linked records under `plan`: the resolved resources no
 * resolved file holds where a decoded resource was, as they will be
 * written, in the order the links first reach them. Each is `Provisional`
 * when a referent of the batch owns it (a provisional resource is its
 * referent's own record), else `Stored`: a `Decoded` target's resource is
 * always in the batch. No resolved file holds them; they are the batch's
 * own, reviewed and written beside the files.
 */
const linkedRecords = (plan: LinkPlan.Type): readonly LinkedRecord[] =>
  pipe(
    LinkPlan.resolvedResources(plan),
    Array.filter(({ resourceExistsInBatch }) => !resourceExistsInBatch),
    Array.map(({ resource, label, ownerReferent }): LinkedRecord => ({
      key: linkedKey(resource),
      title: label,
      resource,
      origin: Option.match(ownerReferent, {
        onNone: () => 'Stored' as const,
        onSome: () => 'Provisional' as const,
      }),
    }))
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
