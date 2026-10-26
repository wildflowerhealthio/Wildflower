/**
 * A referent: something the import refers to that may already exist on the
 * device, once per identity, whether the decode emitted its resource or only
 * mentions name it.
 *
 * @remarks
 * A file has many mentions and the identity map has one referent per
 * identity, which is what the reviewer makes a `LinkChoice` for. Today a
 * referent is a patient or a provider; the model does not say so, and a lab
 * requisition or a location fits it the same way.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Identity from './identity.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Mention from './mention.ts'

/** A referent the decode emitted a resource for, keyed by that resource's `identifier[0]`. */
interface AsResource {
  readonly _tag: 'AsResource'
  readonly identity: Identity.Type
  /**
   * Every identifier a search for this referent tries: the resource's own,
   * then the one its demographics derive, when they allow one.
   */
  readonly identifiers: readonly IdentifierAndReference.IdentifierType[]
  readonly resource: LinkableResource.Type
  /** The `DecodedFile.Resource` key the resource is reviewed under. */
  readonly reviewKey: string
  readonly label: string
}

/** A referent named only by mentions, by identifier alone, with no resource in the file. */
interface ByMentionOnly {
  readonly _tag: 'ByMentionOnly'
  readonly identity: Identity.Type
  readonly label: string
}

type Type = AsResource | ByMentionOnly

const { AsResource, ByMentionOnly, $is: is, $match: match } = Data.taggedEnum<Type>()

/** The identity map's key for `referent`. */
const key = (referent: Type): string => Identity.key(referent.identity)

/** The identifiers `referent` brings to whatever it links to. */
const identifiersOf = (referent: Type): readonly IdentifierAndReference.IdentifierType[] =>
  match(referent, {
    AsResource: ({ identifiers }) => identifiers,
    ByMentionOnly: ({ identity }) => [Identity.toIdentifier(identity)],
  })

/**
 * The referent one decoded resource is: `None` for a resource of another
 * type, and for a Patient or Practitioner whose `identifier[0]` names nothing,
 * which the stage writes as it is.
 */
const tryOfResource = (entry: DecodedFile.Resource): Option.Option<AsResource> => {
  const { resource } = entry
  if (!LinkableResource.is(resource)) return Option.none()
  return Option.map(LinkableResource.maybeIdentityOf(resource), (identity) =>
    AsResource({
      identity,
      identifiers: Array.dedupeWith(
        [
          ...resource.identifier,
          ...Option.toArray(LinkableResource.maybeDerivedIdentifier(resource)),
        ].filter(Identity.isNaming),
        IdentifierAndReference.identifierEquivalence
      ),
      resource,
      reviewKey: entry.key,
      label: LinkableResource.labelOf(resource, identity.value),
    })
  )
}

/** The referents one decoded resource's identifier-only mentions name. */
const mentionedIn = (entry: DecodedFile.Resource): readonly ByMentionOnly[] =>
  ResourceReferences.collect(entry.resource).flatMap((reference) =>
    pipe(
      Mention.maybeIdentityOf(entry.resource, reference),
      Option.map((identity) => ByMentionOnly({ identity, label: identity.value })),
      Option.toArray
    )
  )

/**
 * Every referent a decoded file holds, once per identity: those with a
 * resource in review order, then those named only by mentions, in the order
 * their mentions are first seen.
 *
 * @remarks
 * An identifier-only mention of an identity a resource already holds is that
 * referent, not a second one.
 */
const discover = (decodedFile: Pick<DecodedFile.DecodedFile, 'sections'>): readonly Type[] => {
  const entries = DecodedFile.resources(decodedFile)
  const referents: readonly Type[] = [
    ...entries.flatMap((entry) => Option.toArray(tryOfResource(entry))),
    ...entries.flatMap(mentionedIn),
  ]
  return Array.dedupeWith(referents, (left, right) =>
    Identity.equivalence(left.identity, right.identity)
  )
}

/** Every referent of `referents`, keyed by {@link key}. */
const byKey = (referents: readonly Type[]): ReadonlyMap<string, Type> =>
  new Map(referents.map((referent) => [key(referent), referent]))

export { byKey, discover, identifiersOf, is, key, match }
export type { AsResource, ByMentionOnly, Type }
