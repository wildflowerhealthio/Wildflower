/**
 * Redirecting a resource's mentions to their referents' destinations.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Option, pipe } from 'effect'

import * as Destination from './destination.ts'
import * as Identity from './identity.ts'
import type * as LinkPlan from './link-plan.ts'
import * as Mention from './mention.ts'

/**
 * The literal one reference in `mentioningResource` is redirected to under
 * `plan`: for a literal reference, the one its source literal moves to; for an
 * identifier-only one, its identity's destination. `None` when it stays.
 */
const destinationLiteralOf = (
  plan: LinkPlan.Type,
  mentioningResource: FhirResource,
  reference: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  reference.reference === null
    ? pipe(
        Mention.identityOf(mentioningResource, reference),
        Option.flatMapNullable((identity) => plan.destinations.get(Identity.key(identity))),
        Option.flatMap(Destination.literalOf)
      )
    : Option.fromNullable(plan.literalRedirects.get(reference.reference))

/**
 * `mentioningResource` with every reference it carries that names a linked
 * identity re-pointed at that identity's destination, keeping its `display`
 * and its own `identifier`. Walks every reference, not only the mention
 * fields, so a provider named elsewhere moves too. The same object when
 * nothing moves.
 */
const redirectMentions = (plan: LinkPlan.Type, mentioningResource: FhirResource): FhirResource =>
  ResourceReferences.map(mentioningResource, (reference) =>
    Option.match(destinationLiteralOf(plan, mentioningResource, reference), {
      onNone: () => reference,
      onSome: (destinationLiteral) => ({ ...reference, reference: destinationLiteral }),
    })
  )

export { redirectMentions }
