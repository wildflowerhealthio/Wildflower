/**
 * Redirecting a resource's mentions to their referents' destinations.
 *
 * @packageDocumentation
 */

import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import * as LinkPlan from './link-plan.ts'

/**
 * `mentioningResource` with every reference it carries that `plan` redirects
 * placed at its destination, keeping its `display` and its own `identifier`.
 * Walks every reference, not only the mention fields, so a provider named
 * elsewhere moves too. The same object when nothing moves.
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

export { redirectMentions }
