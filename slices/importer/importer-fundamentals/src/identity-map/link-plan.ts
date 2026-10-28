/**
 * The link plan: everything resolving a batch's decoded files on the referent
 * link choices needs, worked out once from the files and the choices, and the
 * lookups that answer the resolution's and the redirection's questions.
 *
 * @remarks
 * A referent's mentions are redirected to its link target. The plan says what
 * each referent's link target is, what the resource under each resolved
 * literal reference becomes once it has assumed the identifiers of the
 * referents linked to it, and which decoded literal references move to a
 * stored resource. Built once per batch by {@link make}, so a referent one
 * file holds is the link target of a mention in another, and read through
 * {@link redirectionIfLinked} and {@link resolvedResourceIfReferent} by the
 * resolution of every file.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, HashMap, HashSet, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as Link from './link.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'
import * as ResolvedResource from './resolved-resource.ts'

/** The link plan for a batch's decoded files, built once by {@link make}. */
interface Type {
  /** Every referent of the batch with its link target, in discovery order. */
  readonly links: readonly Link.Type[]
  /**
   * Each referent's link target under every logical reference that names it
   * (`Referent.byLogicalReferenceKey`), by `LinkableLogicalReference.key`:
   * where a logical-reference mention is redirected.
   */
  readonly linkTargetsByLogicalReferenceKey: HashMap.HashMap<string, LinkTarget.Type>
  /**
   * The resource under each resolved literal reference the links land on, as
   * it will be written: what replaces a decoded resource, what a decoded
   * resource assumes, and what the batch's linked records are.
   */
  readonly resolvedResourcesByResolvedLiteralReference: HashMap.HashMap<
    string,
    ResolvedResource.Type
  >
  /**
   * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource a
   * stored resource stands in for: where a decoded literal reference is
   * redirected, and under which literal reference the resource is written.
   */
  readonly decodedLiteralReferencesToStored: HashMap.HashMap<string, string>
}

/** The literal references the decoded resources of `decodedFiles` the identity map links carry. */
const literalReferencesFromDecodedFiles = (
  decodedFiles: readonly DecodedFile.DecodedFile[]
): HashSet.HashSet<string> =>
  pipe(
    decodedFiles.flatMap(DecodedFile.resources),
    Array.filterMap(({ resource }) =>
      Option.liftPredicate(resource, LinkableResource.is).pipe(
        Option.map(LinkableResource.literalReferenceOf)
      )
    ),
    HashSet.fromIterable
  )

/**
 * The literal references of `decodedLiteralReferences` the batch writes where
 * they were decoded: those `decodedLiteralReferencesToStored` does not move
 * to another stored resource. A decoded resource a stored one under another
 * id replaces is not written under its own literal reference, so a stored
 * copy under that reference, which a mention may link to, is not written by
 * any resolved file.
 */
const writtenAsDecoded = (
  decodedLiteralReferences: HashSet.HashSet<string>,
  decodedLiteralReferencesToStored: HashMap.HashMap<string, string>
): HashSet.HashSet<string> =>
  HashSet.filter(decodedLiteralReferences, (decodedLiteralReference) =>
    HashMap.get(decodedLiteralReferencesToStored, decodedLiteralReference).pipe(
      Option.match({
        onNone: () => true,
        onSome: (storedLiteralReference) => storedLiteralReference === decodedLiteralReference,
      })
    )
  )

/**
 * `Type/<decoded id>` → `Type/<stored id>` for every referent of `links` whose
 * decoded resource a stored resource stands in for.
 */
const decodedLiteralReferencesToStoredOf = (
  links: readonly Link.Type[]
): HashMap.HashMap<string, string> =>
  pipe(
    links,
    Array.filterMap(({ referent, target }) =>
      Option.all({
        asResource: Option.liftPredicate(referent, Referent.is('AsResource')),
        stored: Option.liftPredicate(target, LinkTarget.is('Stored')),
      })
    ),
    Array.map(
      ({ asResource, stored }) =>
        [
          LinkableResource.literalReferenceOf(asResource.resource),
          LinkableResource.literalReferenceOf(stored.resource),
        ] as const
    ),
    HashMap.fromIterable
  )

/** Each link's target under every logical reference that names its referent (`Referent.byLogicalReferenceKey`). */
const linkTargetsByLogicalReferenceKeyOf = (
  links: readonly Link.Type[]
): HashMap.HashMap<string, LinkTarget.Type> => {
  const linkTargetsByReferentKey = HashMap.fromIterable(
    links.map(({ referent, target }) => [Referent.key(referent), target] as const)
  )
  return HashMap.filterMap(
    Referent.byLogicalReferenceKey(links.map(({ referent }) => referent)),
    (referent) => HashMap.get(linkTargetsByReferentKey, Referent.key(referent))
  )
}

/**
 * The plan for a batch's `decodedFiles` under `linkChoices`: each referent's
 * choice made once into its link (`Link.fromChoices`), and every field read
 * off those links.
 *
 * @remarks
 * The referents are the whole batch's (`Referent.discover`), so a
 * `LinkToDecodedReferent` naming a referent one file holds is the link
 * target of a mention in another, and every file is resolved on the same
 * plan. Fails with `Referent.DuplicateReferent` when two decoded resources
 * answer to one logical reference, and with `LinkChoice.InvalidLinkChoice`
 * when a choice cannot be followed for its referent.
 */
const make = (
  decodedFiles: readonly DecodedFile.DecodedFile[],
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<Type, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.gen(function* () {
    const referents = yield* Referent.discover(decodedFiles)
    const links = yield* Link.fromChoices(referents, linkChoices)
    const decodedLiteralReferencesToStored = decodedLiteralReferencesToStoredOf(links)
    const resolvedResourcesByResolvedLiteralReference =
      yield* ResolvedResource.byResolvedLiteralReference(
        links,
        writtenAsDecoded(
          literalReferencesFromDecodedFiles(decodedFiles),
          decodedLiteralReferencesToStored
        )
      )
    return {
      links,
      linkTargetsByLogicalReferenceKey: linkTargetsByLogicalReferenceKeyOf(links),
      resolvedResourcesByResolvedLiteralReference,
      decodedLiteralReferencesToStored,
    }
  })

/**
 * The literal reference `referenceAsDecoded` is redirected to under `plan`,
 * when it names a referent whose link lands on a resource it does not already
 * name: for a decoded literal reference, the stored one that stands in for its
 * decoded resource; for a logical reference, its referent's link target.
 * `None` when it names no such referent, so it stays as decoded.
 */
const redirectionIfLinked = (
  plan: Type,
  referenceAsDecoded: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  referenceAsDecoded.reference === null
    ? pipe(
        LinkableLogicalReference.tryFromReference(referenceAsDecoded),
        Option.map(LinkableLogicalReference.key),
        Option.flatMap((logicalReferenceKey) =>
          HashMap.get(plan.linkTargetsByLogicalReferenceKey, logicalReferenceKey)
        ),
        Option.flatMap(LinkTarget.resourceIfLinked),
        Option.map(LinkableResource.literalReferenceOf)
      )
    : HashMap.get(plan.decodedLiteralReferencesToStored, referenceAsDecoded.reference)

/**
 * The literal reference a decoded resource under `decodedLiteralReference` is
 * written under: the stored one that stands in for it, else its own.
 */
const resolvedLiteralReferenceOf = (plan: Type, decodedLiteralReference: string): string =>
  HashMap.get(plan.decodedLiteralReferencesToStored, decodedLiteralReference).pipe(
    Option.getOrElse(() => decodedLiteralReference)
  )

/**
 * The resource `decodedResource` is written as under `plan`: the resolved
 * resource under the literal reference it is written under, a stored
 * resource's when one stands in for it and its own otherwise. `None` only for
 * a resource that is no referent, no Patient or Practitioner with a qualified
 * first identifier, which is written as decoded: every referent with a
 * resource has a resolved resource under the literal reference it is written
 * under.
 */
const resolvedResourceIfReferent = (
  plan: Type,
  decodedResource: FhirResourceWithId
): Option.Option<ResolvedResource.Type> =>
  pipe(
    Option.liftPredicate(decodedResource, LinkableResource.is),
    Option.map((linkable) =>
      resolvedLiteralReferenceOf(plan, LinkableResource.literalReferenceOf(linkable))
    ),
    Option.flatMap((resolvedLiteralReference) =>
      HashMap.get(plan.resolvedResourcesByResolvedLiteralReference, resolvedLiteralReference)
    )
  )

export { make, redirectionIfLinked, resolvedResourceIfReferent }
export type { Type }
