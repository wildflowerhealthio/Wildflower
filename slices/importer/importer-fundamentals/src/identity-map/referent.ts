/**
 * A referent: something the import refers to that may already exist on the
 * device, once per logical reference, whether the decode emitted its resource
 * or only mentions name it.
 *
 * @remarks
 * A file has many mentions and the identity map has one referent per
 * logical reference, which is what the reviewer makes a `LinkChoice` for. Today a
 * referent is a patient or a provider; the model does not say so, and a lab
 * requisition or a location fits it the same way.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Data, HashMap, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Mention from './mention.ts'

/**
 * A referent the decode emitted a resource for, keyed by that resource's
 * `identifier[0]`. The resource has an `id`, so a mention can point at it.
 */
interface AsResource {
  readonly _tag: 'AsResource'
  readonly logicalReference: LinkableLogicalReference.Type
  /**
   * Every identifier a search for this referent tries: the resource's own,
   * then the one its demographics derive, when they allow one.
   */
  readonly identifiers: readonly IdentifierAndReference.IdentifierType[]
  readonly resource: LinkableResource.WithId
  /** The `DecodedFile.Resource` key the resource is reviewed under. */
  readonly reviewKey: string
  readonly label: string
}

/** A referent named only by mentions, by identifier alone, with no resource in the file. */
interface ByMentionOnly {
  readonly _tag: 'ByMentionOnly'
  readonly logicalReference: LinkableLogicalReference.Type
  readonly label: string
}

type Type = AsResource | ByMentionOnly

const { AsResource, ByMentionOnly, $is: is, $match: match } = Data.taggedEnum<Type>()

/** The identity map's key for `referent`. */
const key = (referent: Type): string => LinkableLogicalReference.key(referent.logicalReference)

/** The identifiers `referent` brings to whatever it links to. */
const identifiersOf = (referent: Type): readonly IdentifierAndReference.IdentifierType[] =>
  match(referent, {
    AsResource: ({ identifiers }) => identifiers,
    ByMentionOnly: ({ logicalReference }) => [logicalReference.identifier],
  })

/**
 * The referent a decoded resource is: `None` for a resource of another type,
 * and for a Patient or Practitioner with no `id` or an unqualified
 * `identifier[0]`, which nothing can point at or be linked to, so the stage
 * writes it as it is.
 */
const tryFromDecodedResource = (entry: DecodedFile.Resource): Option.Option<AsResource> =>
  pipe(
    Option.liftPredicate(entry.resource, LinkableResource.is),
    Option.flatMap((resource) =>
      Option.all({
        resource: LinkableResource.tryIntoWithId(resource),
        logicalReference: LinkableResource.tryIntoLogicalReference(resource),
      })
    ),
    Option.map(({ resource, logicalReference }) =>
      AsResource({
        logicalReference,
        identifiers: pipe(
          [
            ...resource.identifier,
            ...Option.toArray(LinkableResource.maybeDerivedIdentifier(resource)),
          ],
          Array.filter(IdentifierAndReference.isQualifiedIdentifier),
          Array.dedupeWith(IdentifierAndReference.identifierEquivalence)
        ),
        resource,
        reviewKey: entry.key,
        label: LinkableResource.labelOf(resource, logicalReference.identifier.value),
      })
    )
  )

/** The referents one decoded resource's logical-reference mentions name. */
const mentionedIn = (entry: DecodedFile.Resource): readonly ByMentionOnly[] =>
  pipe(
    Mention.of(entry.resource),
    Array.filterMap(({ reference }) =>
      Option.map(LinkableLogicalReference.tryFromReference(reference), (logicalReference) =>
        ByMentionOnly({ logicalReference, label: logicalReference.identifier.value })
      )
    )
  )

/**
 * Every referent a decoded file holds, once per logical reference: those with a
 * resource in review order, then those named only by mentions, in the order
 * their mentions are first seen.
 *
 * @remarks
 * An identifier-only mention of a logical reference a resource already
 * answers to is that referent, not a second one.
 */
const discover = (decodedFile: Pick<DecodedFile.DecodedFile, 'sections'>): readonly Type[] => {
  const entries = DecodedFile.resources(decodedFile)
  const referents: readonly Type[] = [
    ...Array.filterMap(entries, tryFromDecodedResource),
    ...entries.flatMap(mentionedIn),
  ]
  return Array.dedupeWith(referents, (left, right) =>
    LinkableLogicalReference.equivalence(left.logicalReference, right.logicalReference)
  )
}

/** Every referent of `referents`, keyed by {@link key}. */
const byKey = (referents: readonly Type[]): HashMap.HashMap<string, Type> =>
  HashMap.fromIterable(referents.map((referent) => [key(referent), referent] as const))

export { byKey, discover, identifiersOf, is, key, match }
export type { AsResource, ByMentionOnly, Type }
