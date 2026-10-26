/**
 * Redirecting a resource's mentions to their referents' destinations.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Option, pipe } from 'effect'

import * as Destination from './destination.ts'
import type * as LinkPlan from './link-plan.ts'
import * as LogicalReference from './logical-reference.ts'
import * as Mention from './mention.ts'

/**
 * The literal reference `referenceAsDecoded`, one reference
 * `mentioningResource` carries, is placed at under `plan`: for a decoded
 * literal reference, the one it is redirected to; for an identifier-only one,
 * its logical reference's destination. `None` when it stays as decoded.
 */
const maybePlacedLiteralReference = (
  plan: LinkPlan.Type,
  mentioningResource: FhirResource,
  referenceAsDecoded: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  referenceAsDecoded.reference === null
    ? pipe(
        Mention.maybeLogicalReferenceOf(mentioningResource, referenceAsDecoded),
        Option.flatMapNullable((logicalReference) =>
          plan.destinationsByReferentKey.get(LogicalReference.key(logicalReference))
        ),
        Option.flatMap(Destination.maybeLiteralReference)
      )
    : Option.fromNullable(plan.literalReferenceRedirects.get(referenceAsDecoded.reference))

/**
 * `mentioningResource` with every reference it carries that names a linked
 * referent redirected to that referent's destination, keeping its `display`
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
