/**
 * What can stand in for an identity nothing else describes: the one rule by
 * which a referent named only by mentions can still become a record.
 *
 * @packageDocumentation
 */

import { Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option } from 'effect'

import * as Identity from './identity.ts'
import type * as LinkableResource from './linkable-resource.ts'

/**
 * The provisional resource `identity` alone stands for, or `None` when nothing
 * can: a provider's printed name stands for a `Practitioner`
 * (`Practitioner.fromNameIdentifier`); no identity stands for a `Patient`,
 * who is never less than a demographic record.
 *
 * @remarks
 * Exhaustive over the resource types an identity names, so a type with no
 * provisional form says so here rather than by omission.
 */
const forIdentity = (identity: Identity.Type): Option.Option<LinkableResource.WithId> =>
  Match.value(identity).pipe(
    Match.when({ resourceType: 'Practitioner' }, (named) =>
      Practitioner.fromNameIdentifier(Identity.toIdentifier(named))
    ),
    Match.when({ resourceType: 'Patient' }, () => Option.none()),
    Match.exhaustive
  )

export { forIdentity }
