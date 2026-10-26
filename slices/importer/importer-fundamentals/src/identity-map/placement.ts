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
import * as LinkPlan from './link-plan.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Redirection from './redirection.ts'

/** The title of the section the placement appends records the file only mentions under. */
const LINKED_SECTION_TITLE = 'Linked'

/** The review key a record the file only mentions is appended under. */
const linkedKey = (onlyMentioned: LinkableResource.WithId): string =>
  `linked:${LinkableResource.literalReferenceOf(onlyMentioned)}`

/** The placed record under `resource`'s own literal reference, when the plan holds one. */
const maybePlacedRecordAt = (
  plan: LinkPlan.Type,
  resource: LinkableResource.WithId
): Option.Option<LinkableResource.WithId> =>
  pipe(
    Option.fromNullable(
      plan.placedRecordsByLiteralReference.get(LinkableResource.literalReferenceOf(resource))
    ),
    Option.map(({ resource: placed }) => placed)
  )

/**
 * `decodedResource` as it is placed under `plan`: the stored record standing
 * in for it when its referent links to one; else the placed record under its
 * own literal reference, which is itself having assumed what the referents
 * linked to it bring, when anything links to it; else itself. Its mentions
 * are redirected either way.
 */
const placed = (plan: LinkPlan.Type, decodedResource: FhirResource): FhirResource => {
  if (!LinkableResource.is(decodedResource)) {
    return Redirection.redirectMentions(plan, decodedResource)
  }
  const storedStandIn = pipe(
    LinkPlan.maybeStoredDestinationOf(plan.destinationsByReferentKey, decodedResource),
    Option.flatMap((stored) => maybePlacedRecordAt(plan, stored))
  )
  if (Option.isSome(storedStandIn)) return storedStandIn.value
  const placedRecord = pipe(
    LinkableResource.tryWithId(decodedResource),
    Option.flatMap((withId) => maybePlacedRecordAt(plan, withId)),
    Option.getOrElse(() => decodedResource)
  )
  return Redirection.redirectMentions(plan, placedRecord)
}

/** The records `plan` appends under {@link LINKED_SECTION_TITLE}: those the file only mentions. */
const linkedSectionResources = (plan: LinkPlan.Type): readonly DecodedFile.Resource[] =>
  [...plan.placedRecordsByLiteralReference]
    .filter(([, record]) => !record.resourceExistsInFile)
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
