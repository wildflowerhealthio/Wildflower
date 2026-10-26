/**
 * Placing a decoded file on its link plan: each decoded resource written as
 * the record the plan has for it, with its mentions redirected; and the
 * records the file only mentions appended.
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

/**
 * `decodedResource` as it is placed under `plan`: the record the plan writes
 * it as, when it has one (a stored record standing in for it, or itself
 * having assumed what the referents linked to it bring), else itself. Its
 * mentions are redirected either way.
 */
const placed = (plan: LinkPlan.Type, decodedResource: FhirResource): FhirResource =>
  pipe(
    Option.liftPredicate(decodedResource, LinkableResource.is),
    Option.flatMap(LinkableResource.tryWithId),
    Option.flatMap((withId) => LinkPlan.maybePlacedRecordFor(plan, withId)),
    Option.map(({ resource }): FhirResource => resource),
    Option.getOrElse(() => decodedResource),
    (record) => Redirection.redirectMentions(plan, record)
  )

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
