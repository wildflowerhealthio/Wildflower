/**
 * Placing a decoded file on its link plan: each decoded resource replaced by,
 * or written alongside, what its referent becomes, with its mentions
 * redirected; and the destinations the file only mentions appended.
 *
 * @packageDocumentation
 */

import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Option, pipe } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import * as Identity from './identity.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Redirection from './redirection.ts'

/** The title of the section the placement appends resources the file only mentions under. */
const LINKED_SECTION_TITLE = 'Linked'

/** The review key a resource the file only mentions is appended under. */
const linkedKey = (resource: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalOf(resource)}`

/** The stored resource standing in for `decoded`, when its referent links to one. */
const standInFor = (
  plan: LinkPlan.Type,
  decoded: LinkableResource.Type
): Option.Option<LinkableResource.WithId> =>
  pipe(
    LinkPlan.storedDestinationOf(plan.destinations, decoded),
    Option.flatMapNullable((stored) =>
      plan.linkedResources.get(LinkableResource.literalOf(stored))
    ),
    Option.map(({ resource }) => resource)
  )

/**
 * `decoded` as it is written under `plan`: the stored resource standing in for
 * it, or itself, having assumed what its referent's own resource assumes and,
 * when it is a copy of a linked resource the file already holds (a Linked row
 * placed once before), what that resource assumed, with its mentions
 * redirected.
 */
const placed = (plan: LinkPlan.Type, decoded: FhirResource): FhirResource => {
  if (!LinkableResource.is(decoded)) return Redirection.redirectMentions(plan, decoded)
  const standIn = standInFor(plan, decoded)
  if (Option.isSome(standIn)) return standIn.value
  const assumedAsOwnResource = pipe(
    LinkableResource.identityOf(decoded),
    Option.flatMapNullable((identity) => plan.assumedByOwnResource.get(Identity.key(identity))),
    Option.getOrElse(() => [])
  )
  const assumedAsLinkedCopy = pipe(
    Option.fromNullable(decoded.id),
    Option.flatMapNullable((id) =>
      plan.linkedResources.get(LinkableResource.literalOf({ ...decoded, id }))
    ),
    Option.map(({ assumed }) => assumed),
    Option.getOrElse(() => [])
  )
  return Redirection.redirectMentions(
    plan,
    LinkableResource.assumesIdentifiers(decoded, [...assumedAsOwnResource, ...assumedAsLinkedCopy])
  )
}

/** The resources `plan` appends: those the file only mentions, as rows under {@link LINKED_SECTION_TITLE}. */
const linkedRows = (plan: LinkPlan.Type): readonly DecodedFile.Resource[] =>
  [...plan.linkedResources]
    .filter(([, linked]) => linked.existsOnlyAsMentionInFile)
    .map(([literal, { resource }]) => ({
      key: linkedKey(resource),
      title: LinkableResource.labelOf(resource, literal),
      resource,
    }))

/**
 * `decodedFile` placed on `plan`: the file to review, diff and write. Every
 * section keeps its keys; a resource nothing changed in comes back as the
 * same object; the resources the file only mentions are appended last.
 */
const place = (
  decodedFile: DecodedFile.DecodedFile,
  plan: LinkPlan.Type
): DecodedFile.DecodedFile => {
  const sections = decodedFile.sections.map((section) => {
    const resources = section.resources.map((entry) => {
      const resource = placed(plan, entry.resource)
      return resource === entry.resource ? entry : { ...entry, resource }
    })
    return resources.every((entry, at) => entry === section.resources[at])
      ? section
      : { ...section, resources }
  })
  const linked = linkedRows(plan)
  return linked.length === 0
    ? { ...decodedFile, sections }
    : {
        ...decodedFile,
        sections: [...sections, { title: LINKED_SECTION_TITLE, resources: linked }],
      }
}

export { LINKED_SECTION_TITLE, linkedKey, place }
