/**
 * The link plan: everything placing a batch's decoded files on the referent
 * link choices needs, worked out once from the files and the choices, and the
 * lookups that answer the placement's and the redirection's questions.
 *
 * @remarks
 * A referent's mentions are redirected to its link target. The plan says what
 * each referent's link target is, what the resource under each placed literal
 * reference becomes once it has assumed the identifiers of the referents
 * linked to it, and which decoded literal references move to a stored
 * resource. Built once per batch by {@link make}, so a referent one file holds
 * is the link target of a mention in another, and read through
 * {@link maybeRedirectOf} and {@link maybePlacedResourceFor} by the placement
 * of every file.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Effect, HashMap, HashSet, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import type * as Link from './link.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as PlacedResource from './placed-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'

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
   * The resource under each placed literal reference the links land on, as
   * it will be written: what replaces a decoded resource, what a decoded
   * resource assumes, and what the Linked section appends.
   */
  readonly placedResourcesByPlacedLiteralReference: HashMap.HashMap<string, PlacedResource.Type>
  /**
   * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource a
   * stored resource stands in for: where a decoded literal reference is
   * redirected, and under which literal reference the resource is written.
   */
  readonly decodedLiteralReferencesToStored: HashMap.HashMap<string, string>
}

/** The literal references the decoded resources of `decodedFiles` the identity map links carry, those with an `id`. */
const literalReferencesFromDecodedFiles = (
  decodedFiles: readonly DecodedFile.DecodedFile[]
): HashSet.HashSet<string> =>
  pipe(
    decodedFiles.flatMap(DecodedFile.resources),
    Array.filterMap(({ resource }) =>
      Option.liftPredicate(resource, LinkableResource.is).pipe(
        Option.flatMap(LinkableResource.tryIntoWithId),
        Option.map(LinkableResource.literalReferenceOf)
      )
    ),
    HashSet.fromIterable
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
 * choice resolved once into its link, and every field read off those links.
 *
 * @remarks
 * The referents are the whole batch's (`Referent.discover`), so a
 * `LinkToDecodedReferent` naming a referent one file holds resolves from a
 * mention in another, and every file is placed on the same plan. Fails with
 * `Referent.DuplicateReferent` when two decoded resources answer to one
 * logical reference, and with `LinkChoice.InvalidLinkChoice` when a choice
 * cannot be followed for its referent.
 */
const make = (
  decodedFiles: readonly DecodedFile.DecodedFile[],
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<Type, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.gen(function* () {
    const referents = yield* Referent.discover(decodedFiles)
    const links = yield* Resolution.linksOf(linkChoices, referents)
    const placedResourcesByPlacedLiteralReference = yield* PlacedResource.byPlacedLiteralReference(
      links,
      literalReferencesFromDecodedFiles(decodedFiles)
    )
    return {
      links,
      linkTargetsByLogicalReferenceKey: linkTargetsByLogicalReferenceKeyOf(links),
      placedResourcesByPlacedLiteralReference,
      decodedLiteralReferencesToStored: decodedLiteralReferencesToStoredOf(links),
    }
  })

/**
 * The literal reference `referenceAsDecoded` is redirected to under `plan`:
 * for a decoded literal reference, the stored one it moves to; for a logical
 * reference, its referent's link target. `None` when it stays as decoded.
 */
const maybeRedirectOf = (
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
        Option.flatMap(LinkTarget.tryIntoResource),
        Option.map(LinkableResource.literalReferenceOf)
      )
    : HashMap.get(plan.decodedLiteralReferencesToStored, referenceAsDecoded.reference)

/**
 * The resource `decodedResource` is written as under `plan`: the placed
 * resource under the literal reference its own is redirected to, which is a
 * stored resource's when one stands in for it and its own otherwise. `None`
 * when the plan has no resource there, so it is written as decoded.
 */
const maybePlacedResourceFor = (
  plan: Type,
  decodedResource: LinkableResource.WithId
): Option.Option<PlacedResource.Type> => {
  const decodedLiteralReference = LinkableResource.literalReferenceOf(decodedResource)
  return pipe(
    HashMap.get(plan.decodedLiteralReferencesToStored, decodedLiteralReference),
    Option.getOrElse(() => decodedLiteralReference),
    (placedLiteralReference) =>
      HashMap.get(plan.placedResourcesByPlacedLiteralReference, placedLiteralReference)
  )
}

export { make, maybePlacedResourceFor, maybeRedirectOf }
export type { Type }
