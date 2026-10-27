/**
 * A referent: something the import refers to that may already exist on the
 * device, once per logical reference, whether the decode emitted its resource
 * or only mentions name it.
 *
 * @remarks
 * A file has many mentions and the identity map has one referent per
 * identity, which is what the reviewer makes a `LinkChoice` for. A referent
 * with a resource answers to every identifier it brings, the resource's own
 * and the one its demographics derive, so a mention by one of them that no
 * other resource answers to is that referent. Today a
 * referent is a patient or a provider; the model does not say so, and a lab
 * requisition or a location fits it the same way.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Data, Effect, HashMap, Option, pipe, Record } from 'effect'

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
  /** The identifier the resource's demographics derive, when they allow one: the last of `identifiers`. */
  readonly derivedIdentifier: Option.Option<IdentifierAndReference.IdentifierType>
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

/**
 * Two or more decoded resources of a batch, under different ids, are keyed by
 * one logical reference: one identity decoded twice. Nothing decides which of
 * them the identity's mentions mean, so the stage refuses the batch rather
 * than write both.
 */
class DuplicateReferent extends Data.TaggedError('DuplicateReferent')<{
  /** The logical reference their `identifier[0]` makes. */
  readonly logicalReference: LinkableLogicalReference.Type
  /** The `DecodedFile.Resource` keys of the resources, in review order. */
  readonly reviewKeys: readonly string[]
}> {}

/** The identity map's key for `referent`. */
const key = (referent: Type): string => LinkableLogicalReference.key(referent.logicalReference)

/**
 * The logical references `referent`'s own identifiers make, its key's first:
 * the ones a source gave it, not one demographics derive
 * (`LinkableResource.isDerivedIdentifier`), which a resolved resource carries
 * too.
 */
const ownLogicalReferencesOf = (referent: Type): readonly LinkableLogicalReference.Type[] =>
  match(referent, {
    AsResource: ({ logicalReference, resource }) =>
      pipe(
        resource.identifier,
        Array.filter((identifier) => !LinkableResource.isDerivedIdentifier(identifier)),
        Array.filterMap((identifier) =>
          LinkableLogicalReference.tryFromIdentifier(logicalReference.type, identifier)
        )
      ),
    ByMentionOnly: ({ logicalReference }) => [logicalReference],
  })

/**
 * The logical reference `referent`'s demographics derive, when they allow one
 * (`LinkableResource.maybeDerivedIdentifier`); a referent named only by
 * mentions derives none.
 */
const maybeDerivedLogicalReferenceOf = (
  referent: Type
): Option.Option<LinkableLogicalReference.Type> =>
  match(referent, {
    AsResource: ({ logicalReference, derivedIdentifier }) =>
      Option.flatMap(derivedIdentifier, (identifier) =>
        LinkableLogicalReference.tryFromIdentifier(logicalReference.type, identifier)
      ),
    ByMentionOnly: () => Option.none(),
  })

/**
 * Every logical reference `referent` answers to: its own
 * ({@link ownLogicalReferencesOf}), then the derived one
 * ({@link maybeDerivedLogicalReferenceOf}), once each.
 */
const logicalReferencesOf = (referent: Type): readonly LinkableLogicalReference.Type[] =>
  Array.dedupeWith(
    [
      ...ownLogicalReferencesOf(referent),
      ...Option.toArray(maybeDerivedLogicalReferenceOf(referent)),
    ],
    LinkableLogicalReference.equivalence
  )

/** The identifiers `referent` brings to whatever it links to. */
const identifiersOf = (referent: Type): readonly IdentifierAndReference.IdentifierType[] =>
  match(referent, {
    AsResource: ({ identifiers }) => identifiers,
    ByMentionOnly: ({ logicalReference }) => [logicalReference.identifier],
  })

/**
 * The referent a decoded resource is: `None` for a resource of another type,
 * and for a Patient or Practitioner with an unqualified `identifier[0]`, which
 * nothing can be linked to, so the stage writes it as it is.
 */
const tryFromDecodedResource = (
  entry: DecodedFile.Resource
): Effect.Effect<Option.Option<AsResource>> =>
  pipe(
    Option.liftPredicate(entry.resource, LinkableResource.is),
    Option.flatMap((resource) =>
      Option.map(LinkableResource.tryIntoLogicalReference(resource), (logicalReference) => ({
        resource,
        logicalReference,
      }))
    ),
    Effect.transposeMapOption(({ resource, logicalReference }) =>
      Effect.all({
        derivedIdentifier: LinkableResource.maybeDerivedIdentifier(resource),
        label: LinkableResource.labelOf(resource, logicalReference.identifier.value),
      }).pipe(
        Effect.map(({ derivedIdentifier, label }) =>
          AsResource({
            logicalReference,
            identifiers: pipe(
              [...resource.identifier, ...Option.toArray(derivedIdentifier)],
              Array.filter(IdentifierAndReference.isQualifiedIdentifier),
              Array.dedupeWith(IdentifierAndReference.identifierEquivalence)
            ),
            derivedIdentifier,
            resource,
            reviewKey: entry.key,
            label,
          })
        )
      )
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

/** Every referent of `referents`, keyed by {@link key}. */
const byKey = (referents: readonly Type[]): HashMap.HashMap<string, Type> =>
  HashMap.fromIterable(referents.map((referent) => [key(referent), referent] as const))

/**
 * The referent each logical reference names among `referents`, by
 * `LinkableLogicalReference.key`: the referent it is the key of, else the one
 * referent that answers to it (`logicalReferencesOf`). A logical reference
 * several referents answer to, and none is keyed by, names none of them.
 */
const byLogicalReferenceKey = (referents: readonly Type[]): HashMap.HashMap<string, Type> => {
  const referentsByKey = byKey(referents)
  const answeredByOne = pipe(
    referents.flatMap((referent) =>
      logicalReferencesOf(referent).map((logicalReference) => ({
        logicalReferenceKey: LinkableLogicalReference.key(logicalReference),
        referent,
      }))
    ),
    Array.groupBy(({ logicalReferenceKey }) => logicalReferenceKey),
    Record.toEntries,
    Array.filterMap(([logicalReferenceKey, answering]) =>
      answering.length === 1 && !HashMap.has(referentsByKey, logicalReferenceKey)
        ? Option.some([logicalReferenceKey, answering[0].referent] as const)
        : Option.none()
    )
  )
  return HashMap.union(referentsByKey, HashMap.fromIterable(answeredByOne))
}

/**
 * The first key two of `asResources` share under different ids, as the
 * failure it is.
 */
const firstDuplicateAmong = (
  asResources: readonly AsResource[]
): Option.Option<DuplicateReferent> =>
  pipe(
    asResources,
    Array.groupBy((asResource) => key(asResource)),
    Record.values,
    Array.findFirst((sharingKey) =>
      Array.dedupe(sharingKey.map(({ resource }) => resource.id)).length < 2
        ? Option.none()
        : Option.some(
            new DuplicateReferent({
              logicalReference: sharingKey[0].logicalReference,
              reviewKeys: sharingKey.map(({ reviewKey }) => reviewKey),
            })
          )
    )
  )

/**
 * Every referent a batch's decoded files hold, once per identity: those with
 * a resource in file-then-review order, then those named only by mentions, in
 * the order their mentions are first seen.
 *
 * @remarks
 * A mention of a logical reference a resource's referent is keyed by, or the
 * only one to answer to, is that referent, not a second one, whichever file
 * each is in: a person one file decodes and another only mentions is one
 * referent, with the resource. A resource decoded twice under one id is one
 * referent, its first copy's. Fails with {@link DuplicateReferent} when two
 * resources under different ids, in one file or two, are keyed by one logical
 * reference.
 */
const discover = (
  decodedFiles: readonly Pick<DecodedFile.DecodedFile, 'sections'>[]
): Effect.Effect<readonly Type[], DuplicateReferent> =>
  Effect.gen(function* () {
    const entries = decodedFiles.flatMap(DecodedFile.resources)
    const decodedAsResources = Array.getSomes(
      yield* Effect.forEach(entries, tryFromDecodedResource)
    )
    const duplicate = firstDuplicateAmong(decodedAsResources)
    if (Option.isSome(duplicate)) return yield* Effect.fail(duplicate.value)
    const asResources = Array.dedupeWith(
      decodedAsResources,
      (left, right) => key(left) === key(right)
    )
    const namedByAsResource = byLogicalReferenceKey(asResources)
    const byMentionOnly = pipe(
      entries.flatMap(mentionedIn),
      Array.filter((referent) => !HashMap.has(namedByAsResource, key(referent))),
      Array.dedupeWith((left, right) => key(left) === key(right))
    )
    return [...asResources, ...byMentionOnly]
  })

export {
  byKey,
  byLogicalReferenceKey,
  discover,
  DuplicateReferent,
  identifiersOf,
  is,
  key,
  logicalReferencesOf,
  match,
  maybeDerivedLogicalReferenceOf,
  ownLogicalReferencesOf,
}
export type { AsResource, ByMentionOnly, Type }
