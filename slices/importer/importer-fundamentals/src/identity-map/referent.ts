/**
 * A referent: a Patient or Practitioner the import holds a record of, which
 * may already exist on the device, once per logical reference.
 *
 * @remarks
 * A file has many mentions and the identity map has one referent per
 * identity, which is what the reviewer makes a `LinkChoice` for. A referent
 * answers to every identifier it brings, its record's own and the one its
 * demographics derive, so a mention by one of them that no other referent
 * answers to is that referent. Every referent has a record: a reference to a
 * record the import never saw implies that record at decode
 * (`DecodedFileSet.adopt`). Today a referent is a patient or a provider; the
 * model does not say so, and a lab requisition or a location fits it the same
 * way.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Data, Effect, HashMap, Option, pipe, Record } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'

/**
 * A referent, keyed by its record's `identifier[0]`. The record has an `id`,
 * so a mention can point at it.
 */
interface Type {
  readonly logicalReference: LinkableLogicalReference.Type
  /**
   * Every identifier a search for this referent tries: the record's own,
   * then the one its demographics derive, when they allow one.
   */
  readonly identifiers: readonly IdentifierAndReference.IdentifierType[]
  /** The identifier the record's demographics derive, when they allow one: the last of `identifiers`. */
  readonly derivedIdentifier: Option.Option<IdentifierAndReference.IdentifierType>
  readonly resource: LinkableResource.WithId
  /** The `DecodedFile.Resource` key the record is reviewed under. */
  readonly reviewKey: string
  readonly label: string
}

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
const ownLogicalReferencesOf = ({
  logicalReference,
  resource,
}: Type): readonly LinkableLogicalReference.Type[] =>
  pipe(
    resource.identifier,
    Array.filter((identifier) => !LinkableResource.isDerivedIdentifier(identifier)),
    Array.filterMap((identifier) =>
      LinkableLogicalReference.tryFromIdentifier(logicalReference.type, identifier)
    )
  )

/**
 * The logical reference `referent`'s demographics derive, when they allow one
 * (`LinkableResource.maybeDerivedIdentifier`).
 */
const maybeDerivedLogicalReferenceOf = ({
  logicalReference,
  derivedIdentifier,
}: Type): Option.Option<LinkableLogicalReference.Type> =>
  Option.flatMap(derivedIdentifier, (identifier) =>
    LinkableLogicalReference.tryFromIdentifier(logicalReference.type, identifier)
  )

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

/**
 * The referent a decoded resource is: `None` for a resource of another type,
 * and for a Patient or Practitioner with an unqualified `identifier[0]`, which
 * nothing can be linked to, so the stage writes it as it is.
 */
const tryFromDecodedResource = (entry: DecodedFile.Resource): Effect.Effect<Option.Option<Type>> =>
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
        Effect.map(({ derivedIdentifier, label }): Type => ({
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
        }))
      )
    )
  )

/** Every referent of `referents`, keyed by {@link key}. */
const byKey = (referents: readonly Type[]): HashMap.HashMap<string, Type> =>
  HashMap.fromIterable(referents.map((referent) => [key(referent), referent] as const))

/** The first key two of `referents` share under different ids, as the failure it is. */
const firstDuplicateAmong = (referents: readonly Type[]): Option.Option<DuplicateReferent> =>
  pipe(
    referents,
    Array.groupBy((referent) => key(referent)),
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
 * Every referent a batch's decoded files hold, once per identity, in
 * file-then-review order.
 *
 * @remarks
 * A resource decoded twice under one id (two file sets implying one
 * Practitioner, say) is one referent, its first copy's. Fails with
 * {@link DuplicateReferent} when two resources under different ids, in one
 * file or two, are keyed by one logical reference.
 */
const discover = (
  decodedFiles: readonly Pick<DecodedFile.DecodedFile, 'sections'>[]
): Effect.Effect<readonly Type[], DuplicateReferent> =>
  Effect.gen(function* () {
    const decodedReferents = Array.getSomes(
      yield* Effect.forEach(decodedFiles.flatMap(DecodedFile.resources), tryFromDecodedResource)
    )
    const duplicate = firstDuplicateAmong(decodedReferents)
    if (Option.isSome(duplicate)) return yield* Effect.fail(duplicate.value)
    return Array.dedupeWith(decodedReferents, (left, right) => key(left) === key(right))
  })

export {
  byKey,
  discover,
  DuplicateReferent,
  key,
  logicalReferencesOf,
  maybeDerivedLogicalReferenceOf,
  ownLogicalReferencesOf,
}
export type { Type }
