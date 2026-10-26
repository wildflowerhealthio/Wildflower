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
 * The literal reference `referenceAsDecoded`, one reference
 * `mentioningResource` carries, is placed at under `plan`: for a decoded
 * literal reference, the one it is redirected to; for an identifier-only one,
 * its identity's destination. `None` when it stays as decoded.
 */
const maybePlacedLiteralReference = (
  plan: LinkPlan.Type,
  mentioningResource: FhirResource,
  referenceAsDecoded: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  referenceAsDecoded.reference === null
    ? pipe(
        Mention.maybeIdentityOf(mentioningResource, referenceAsDecoded),
        Option.flatMapNullable((identity) =>
          plan.destinationsByReferentKey.get(Identity.key(identity))
        ),
        Option.flatMap(Destination.maybeLiteralReference)
      )
    : Option.fromNullable(plan.literalReferenceRedirects.get(referenceAsDecoded.reference))

/**
 * `mentioningResource` with every reference it carries that names a linked
 * identity redirected to that identity's destination, keeping its `display`
 * and its own `identifier`. Walks every reference, not only the mention
 * fields, so a provider named elsewhere moves too. The same object when
 * nothing moves.
 */
const redirectMentions = (plan: LinkPlan.Type, mentioningResource: FhirResource): FhirResource =>
  ResourceReferences.map(mentioningResource, (referenceAsDecoded) =>
    Option.match(maybePlacedLiteralReference(plan, mentioningResource, referenceAsDecoded), {
      onNone: () => referenceAsDecoded,
      onSome: (placedLiteralReference) => ({
        ...referenceAsDecoded,
        reference: placedLiteralReference,
      }),
    })
  )

export { redirectMentions }
