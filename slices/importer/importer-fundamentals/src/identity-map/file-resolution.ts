/**
 * Resolving a decoded file on its batch's link plan: each decoded resource
 * written as the resource the plan has for it, with its mentions redirected to
 * their referents' link targets; and the resources the batch only mentions,
 * as the batch's own linked records.
 *
 * @packageDocumentation
 */

import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, HashMap, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'

/** The review key a resource the batch only mentions is reviewed under, among the batch's linked records. */
const linkedKey = (onlyMentioned: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalReferenceOf(onlyMentioned)}`

/**
 * `mentioningResource` with every reference it carries that `plan` redirects
 * pointed at its referent's link target, keeping its `display` and its own
 * `identifier`. Walks every reference, not only the mention fields, so a
 * provider named elsewhere moves too. The same object when nothing moves.
 */
const redirectMentions = (plan: LinkPlan.Type, mentioningResource: FhirResource): FhirResource =>
  ResourceReferences.map(mentioningResource, (referenceAsDecoded) =>
    Option.match(LinkPlan.maybeRedirectOf(plan, referenceAsDecoded), {
      onNone: () => referenceAsDecoded,
      onSome: (resolvedLiteralReference) => ({
        ...referenceAsDecoded,
        reference: resolvedLiteralReference,
      }),
    })
  )

/**
 * `decodedEntry` as it is resolved under `plan`: its resource written as the
 * resource the plan has for it, when it has one (a stored resource standing in
 * for it, or itself having assumed what the referents linked to it bring),
 * else as itself, with its mentions redirected either way. An entry whose
 * resource a stored one replaces takes the stored one's label as its title;
 * any other keeps its own. The same object when nothing changes.
 */
const resolvedEntry = (
  plan: LinkPlan.Type,
  decodedEntry: DecodedFile.Resource
): DecodedFile.Resource => {
  const decodedResource = decodedEntry.resource
  const maybeResolvedResource = pipe(
    Option.liftPredicate(decodedResource, LinkableResource.is),
    Option.flatMap(LinkableResource.tryIntoWithId),
    Option.flatMap((withId) => LinkPlan.maybeResolvedResourceFor(plan, withId))
  )
  const resource = redirectMentions(
    plan,
    Option.match(maybeResolvedResource, {
      onNone: () => decodedResource,
      onSome: (resolvedResource): FhirResource => resolvedResource.resource,
    })
  )
  const title = pipe(
    maybeResolvedResource,
    Option.filter((resolvedResource) => resolvedResource.resource.id !== decodedResource.id),
    Option.match({
      onNone: () => decodedEntry.title,
      onSome: (resolvedResource) => resolvedResource.label,
    })
  )
  return resource === decodedResource && title === decodedEntry.title
    ? decodedEntry
    : { ...decodedEntry, title, resource }
}

/**
 * The batch's linked records under `plan`: the resources it only mentions, as
 * they will be written, keyed by {@link linkedKey} and titled by their label,
 * in the order their referents were discovered. No resolved file holds them;
 * they are the batch's own, reviewed and written beside the files.
 */
const linkedResources = (plan: LinkPlan.Type): readonly DecodedFile.Resource[] =>
  pipe(
    plan.links,
    Array.filterMap(({ target }) => LinkTarget.tryIntoResource(target)),
    Array.map(LinkableResource.literalReferenceOf),
    Array.dedupe,
    Array.filterMap((resolvedLiteralReference) =>
      HashMap.get(plan.resolvedResourcesByResolvedLiteralReference, resolvedLiteralReference).pipe(
        Option.filter((resolvedResource) => !resolvedResource.resourceExistsInBatch),
        Option.map(({ resource, label }) => ({ key: linkedKey(resource), title: label, resource }))
      )
    )
  )

/**
 * `decodedFile` resolved on `plan`: the file to review, diff and write. Every
 * section keeps its keys, and an entry nothing changed in comes back as the
 * same object. The resources the batch only mentions are no file's: they are
 * {@link linkedResources}.
 */
const resolveFile = (
  decodedFile: DecodedFile.DecodedFile,
  plan: LinkPlan.Type
): DecodedFile.DecodedFile =>
  DecodedFile.mapResources(decodedFile, (decodedEntry) => resolvedEntry(plan, decodedEntry))

export { linkedKey, linkedResources, resolveFile }
