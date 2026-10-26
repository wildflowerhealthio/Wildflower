/**
 * Placing a decoded file on its link plan: each decoded resource replaced by,
 * or written alongside, what its referent becomes, with its mentions
 * redirected; and the records the file only mentions appended.
 *
 * @packageDocumentation
 */

import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Identity from './identity.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Redirection from './redirection.ts'

/** The title of the section the placement appends records the file only mentions under. */
const LINKED_SECTION_TITLE = 'Linked'

/** The review key a record the file only mentions is appended under. */
const linkedKey = (onlyMentioned: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalReferenceOf(onlyMentioned)}`

/** The stored record, as it will be written, standing in for `decodedResource` when its referent links to one. */
const maybeStoredStandInFor = (
  plan: LinkPlan.Type,
  decodedResource: LinkableResource.Type
): Option.Option<LinkableResource.WithId> =>
  pipe(
    LinkPlan.maybeStoredDestinationOf(plan.destinationsByReferentKey, decodedResource),
    Option.flatMapNullable((stored) =>
      plan.destinationResourcesByLiteralReference.get(LinkableResource.literalReferenceOf(stored))
    ),
    Option.map(({ resource }) => resource)
  )

/**
 * `decodedResource` as it is placed under `plan`: the stored record standing
 * in for it, or itself, having assumed what its referent's decoded resource
 * assumes and, when it is a copy of a linked record the file already holds
 * (appended under Linked by an earlier placement), what that record assumed,
 * with its mentions redirected.
 */
const placed = (plan: LinkPlan.Type, decodedResource: FhirResource): FhirResource => {
  if (!LinkableResource.is(decodedResource)) {
    return Redirection.redirectMentions(plan, decodedResource)
  }
  const storedStandIn = maybeStoredStandInFor(plan, decodedResource)
  if (Option.isSome(storedStandIn)) return storedStandIn.value
  const assumedAsDecodedResource = pipe(
    LinkableResource.maybeIdentityOf(decodedResource),
    Option.flatMapNullable((identity) =>
      plan.identifiersToAssumeByReferentKey.get(Identity.key(identity))
    ),
    Option.getOrElse(() => [])
  )
  const assumedAsLinkedCopy = pipe(
    Option.fromNullable(decodedResource.id),
    Option.flatMapNullable((id) =>
      plan.destinationResourcesByLiteralReference.get(
        LinkableResource.literalReferenceOf({ ...decodedResource, id })
      )
    ),
    Option.map(({ identifiersToAssume }) => identifiersToAssume),
    Option.getOrElse(() => [])
  )
  return Redirection.redirectMentions(
    plan,
    LinkableResource.assumesIdentifiers(decodedResource, [
      ...assumedAsDecodedResource,
      ...assumedAsLinkedCopy,
    ])
  )
}

/** The records `plan` appends under {@link LINKED_SECTION_TITLE}: those the file only mentions. */
const linkedSectionResources = (plan: LinkPlan.Type): readonly DecodedFile.Resource[] =>
  [...plan.destinationResourcesByLiteralReference]
    .filter(([, linked]) => !linked.resourceExistsInFile)
    .map(([literalReference, { resource }]) => ({
      key: linkedKey(resource),
      title: LinkableResource.labelOf(resource, literalReference),
      resource,
    }))

/**
 * `decodedFile` placed on `plan`: the file to review, diff and write. Every
 * section keeps its keys; a resource nothing changed in comes back as the
 * same object; the records the file only mentions are appended last.
 */
const place = (
  decodedFile: DecodedFile.DecodedFile,
  plan: LinkPlan.Type
): DecodedFile.DecodedFile => {
  const placedFile = DecodedFile.mapResources(decodedFile, (resource) => placed(plan, resource))
  const linked = linkedSectionResources(plan)
  return linked.length === 0
    ? placedFile
    : {
        ...placedFile,
        sections: [...placedFile.sections, { title: LINKED_SECTION_TITLE, resources: linked }],
      }
}

export { LINKED_SECTION_TITLE, linkedKey, place }
