/**
 * A referent: a Patient or Practitioner the import holds a record of, which
 * may already exist on the device, once per logical reference.
 *
 * @remarks
 * A file has many mentions and the identity map has one referent per
 * identity, which is what the reviewer makes a `LinkChoice` for. A referent
 * answers to every identifier its record brings, so a mention by one of them
 * that no other referent answers to is that referent. Every referent has a record: a reference to a
 * record the import never saw implies that record at decode
 * (`DecodedFileSet.adopt`). Today a referent is a patient or a provider; the
 * model does not say so, and a lab requisition or a location fits it the same
 * way.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Data, Effect, HashMap, Option, pipe, Record } from 'effect'

import type * as ReviewRow from '../review-row.ts'
import type * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'

/**
 * A referent, keyed by its record's `identifier[0]`. The record has an `id`,
 * so a mention can point at it.
 */
interface Type {
  readonly logicalReference: LinkableLogicalReference.Type
  /** Every qualified identifier the record carries, once each: what the referent answers to. */
  readonly identifiers: readonly IdentifierAndReference.IdentifierType[]
  readonly resource: LinkableResource.WithId
  /** The review key of the record's row. */
  readonly reviewKey: string
  /** Whether the record's row is implied (`ReviewRow.Type`'s `isImplied`). */
  readonly isImplied: boolean
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
  /** The resources' review keys, in review order. */
  readonly reviewKeys: readonly string[]
}> {}

/** The identity map's key for `referent`. */
const key = (referent: Type): LogicalReference.Key =>
  LogicalReference.key(referent.logicalReference)

/**
 * Every logical reference `referent` answers to: one per qualified
 * identifier its record carries, its key's first.
 */
const logicalReferencesOf = ({
  logicalReference,
  resource,
}: Type): readonly LinkableLogicalReference.Type[] =>
  Array.dedupeWith(
    Array.filterMap(resource.identifier, (identifier) =>
      LogicalReference.tryFromIdentifier(logicalReference.resourceType, identifier)
    ),
    LogicalReference.equivalence
  )

/**
 * The referent a decoded resource is: `None` for a resource of another type,
 * and for a Patient or Practitioner with an unqualified `identifier[0]`, which
 * nothing can be linked to, so the stage writes it as it is.
 */
const tryFromDecodedResource = (row: ReviewRow.Type): Effect.Effect<Option.Option<Type>> =>
  pipe(
    Option.liftPredicate(row.resource, LinkableResource.is),
    Option.flatMap((resource) =>
      Option.map(LinkableResource.tryIntoLogicalReference(resource), (logicalReference) => ({
        resource,
        logicalReference,
      }))
    ),
    Effect.transposeMapOption(({ resource, logicalReference }) =>
      Effect.map(
        LinkableResource.labelOf(resource, logicalReference.identifier[0].value),
        (label): Type => ({
          logicalReference,
          identifiers: pipe(
            resource.identifier,
            Array.filter(IdentifierAndReference.isQualifiedIdentifier),
            Array.dedupeWith(IdentifierAndReference.identifierEquivalence)
          ),
          resource,
          reviewKey: row.reviewKey,
          isImplied: row.isImplied,
          label,
        })
      )
    )
  )

/** Every referent of `referents`, keyed by {@link key}. */
const byKey = (referents: readonly Type[]): HashMap.HashMap<LogicalReference.Key, Type> =>
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
 * Every referent the decoded rows of a batch hold, once per identity, in
 * the order of `decodedRows`.
 *
 * @remarks
 * A resource decoded twice under one id (two file sets implying one
 * Practitioner, say) is one referent, in the place of its first copy: the
 * first copy a file decoded, else the first implied one (`isImplied`),
 * since an implied record says only what a reference to it said. Fails with
 * {@link DuplicateReferent} when two resources under different ids, in one
 * file or two, are keyed by one logical reference.
 */
const discover = (
  decodedRows: readonly ReviewRow.Type[]
): Effect.Effect<readonly Type[], DuplicateReferent> =>
  Effect.gen(function* () {
    const decodedReferents = Array.getSomes(
      yield* Effect.forEach(decodedRows, tryFromDecodedResource)
    )
    const duplicate = firstDuplicateAmong(decodedReferents)
    if (Option.isSome(duplicate)) return yield* Effect.fail(duplicate.value)
    const firstDecodedByKey = byKey(
      decodedReferents.filter(({ isImplied }) => !isImplied).toReversed()
    )
    return Array.dedupeWith(decodedReferents, (left, right) => key(left) === key(right)).map(
      (referent) => Option.getOrElse(HashMap.get(firstDecodedByKey, key(referent)), () => referent)
    )
  })

export { byKey, discover, DuplicateReferent, key, logicalReferencesOf }
export type { Type }
