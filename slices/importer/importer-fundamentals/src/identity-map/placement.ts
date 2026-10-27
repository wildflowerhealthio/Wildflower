/**
 * Placing a decoded file on its batch's link plan: each decoded resource
 * written as the resource the plan has for it, with its mentions redirected to
 * their referents' link targets; and, once per batch, the resources the batch
 * only mentions appended.
 *
 * @packageDocumentation
 */

import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, HashMap, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'

/** The title of the section resources the batch only mentions are appended under. */
const LINKED_SECTION_TITLE = 'Linked'

/** The review key a resource the batch only mentions is appended under. */
const linkedKey = (onlyMentioned: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalReferenceOf(onlyMentioned)}`

/**
 * `mentioningResource` with every reference it carries that `plan` redirects
 * placed at its referent's link target, keeping its `display` and its own
 * `identifier`. Walks every reference, not only the mention fields, so a
 * provider named elsewhere moves too. The same object when nothing moves.
 */
const redirectMentions = (plan: LinkPlan.Type, mentioningResource: FhirResource): FhirResource =>
  ResourceReferences.map(mentioningResource, (referenceAsDecoded) =>
    Option.match(LinkPlan.maybeRedirectOf(plan, referenceAsDecoded), {
      onNone: () => referenceAsDecoded,
      onSome: (placedLiteralReference) => ({
        ...referenceAsDecoded,
        reference: placedLiteralReference,
      }),
    })
  )

/**
 * `decodedEntry` as it is placed under `plan`: its resource written as the
 * resource the plan has for it, when it has one (a stored resource standing in
 * for it, or itself having assumed what the referents linked to it bring),
 * else as itself, with its mentions redirected either way. An entry whose
 * resource a stored one replaces takes the stored one's label as its title;
 * any other keeps its own. The same object when nothing changes.
 */
const placed = (plan: LinkPlan.Type, decodedEntry: DecodedFile.Resource): DecodedFile.Resource => {
  const decodedResource = decodedEntry.resource
  const maybePlacedResource = pipe(
    Option.liftPredicate(decodedResource, LinkableResource.is),
    Option.flatMap(LinkableResource.tryIntoWithId),
    Option.flatMap((withId) => LinkPlan.maybePlacedResourceFor(plan, withId))
  )
  const resource = redirectMentions(
    plan,
    Option.match(maybePlacedResource, {
      onNone: () => decodedResource,
      onSome: (placedResource): FhirResource => placedResource.resource,
    })
  )
  const title = pipe(
    maybePlacedResource,
    Option.filter((placedResource) => placedResource.resource.id !== decodedResource.id),
    Option.match({
      onNone: () => decodedEntry.title,
      onSome: (placedResource) => placedResource.label,
    })
  )
  return resource === decodedResource && title === decodedEntry.title
    ? decodedEntry
    : { ...decodedEntry, title, resource }
}

/**
 * The resources `plan` appends under {@link LINKED_SECTION_TITLE}: those the
 * batch only mentions, in the order their referents were discovered.
 */
const linkedSectionResources = (plan: LinkPlan.Type): readonly DecodedFile.Resource[] =>
  pipe(
    plan.links,
    Array.filterMap(({ target }) => LinkTarget.tryIntoResource(target)),
    Array.map(LinkableResource.literalReferenceOf),
    Array.dedupe,
    Array.filterMap((placedLiteralReference) =>
      HashMap.get(plan.placedResourcesByPlacedLiteralReference, placedLiteralReference).pipe(
        Option.filter((placedResource) => !placedResource.resourceExistsInBatch),
        Option.map(({ resource, label }) => ({ key: linkedKey(resource), title: label, resource }))
      )
    )
  )

/**
 * `decodedFile` placed on `plan`: the file to review, diff and write. Every
 * section keeps its keys, and an entry nothing changed in comes back as the
 * same object. The resources the batch only mentions are not appended here
 * but once per batch, by {@link appendLinkedSection}.
 */
const place = (
  decodedFile: DecodedFile.DecodedFile,
  plan: LinkPlan.Type
): DecodedFile.DecodedFile =>
  DecodedFile.mapResources(decodedFile, (decodedEntry) => placed(plan, decodedEntry))

/**
 * `placedFile` with the resources the batch `plan` was made for only mentions
 * appended last, under {@link LINKED_SECTION_TITLE}; `placedFile` itself when
 * there are none.
 *
 * @remarks
 * Appended to one file of the batch, the first, so a stored person the batch
 * only mentions is written once however many files mention it.
 */
const appendLinkedSection = (
  placedFile: DecodedFile.DecodedFile,
  plan: LinkPlan.Type
): DecodedFile.DecodedFile => {
  const linked = linkedSectionResources(plan)
  return linked.length === 0
    ? placedFile
    : {
        ...placedFile,
        sections: [...placedFile.sections, { title: LINKED_SECTION_TITLE, resources: linked }],
      }
}

export { appendLinkedSection, LINKED_SECTION_TITLE, linkedKey, place }
