/**
 * The link plan: everything placing a decoded file on the referent link
 * choices needs, worked out once from the file and the choices, and the
 * lookups that answer the placement's and the redirection's questions.
 *
 * @remarks
 * A referent's mentions are redirected to its link target. The plan says what
 * each referent's link target is, what the resource under each placed literal
 * reference becomes once it has assumed the identifiers of the referents
 * linked to it, and which decoded literal references move to a stored
 * resource. Built by {@link make}, read through {@link maybeRedirectOf} and
 * {@link maybePlacedResourceFor}, and what the batch lift hands across files.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, HashMap, HashSet, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkTarget from './link-target.ts'
import type * as Link from './link.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as PlacedResource from './placed-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'

/** The link plan for one decoded file, built once by {@link make}. */
interface Type {
  /** Every referent of the file with its link target, in discovery order. */
  readonly links: readonly Link.Type[]
  /**
   * Each referent's link target: where a logical-reference mention is
   * redirected, and which decoded resources a stored resource replaces.
   */
  readonly linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>
  /**
   * The resource under each placed literal reference the links land on, as
   * it will be written: what replaces a decoded resource, what a decoded
   * resource assumes, and what the Linked section appends.
   */
  readonly placedResourcesByPlacedLiteralReference: HashMap.HashMap<string, PlacedResource.Type>
  /**
   * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource a
   * stored resource stands in for, a second resource of the same logical
   * reference under another id included: where a decoded literal reference
   * is redirected, and under which literal reference the resource is written.
   */
  readonly decodedLiteralReferencesToStored: HashMap.HashMap<string, string>
}

/** The decoded resources of `decodedFile` the identity map links, those with an `id`. */
const linkableResourcesWithIdFromDecodedFile = (
  decodedFile: DecodedFile.DecodedFile
): readonly LinkableResource.WithId[] =>
  pipe(
    DecodedFile.resources(decodedFile),
    Array.filterMap(({ resource }) =>
      Option.liftPredicate(resource, LinkableResource.is).pipe(
        Option.flatMap(LinkableResource.tryIntoWithId)
      )
    )
  )

/** The literal references the decoded resources of `decodedFile` carry. */
const literalReferencesFromDecodedFile = (
  decodedFile: DecodedFile.DecodedFile
): HashSet.HashSet<string> =>
  HashSet.fromIterable(
    linkableResourcesWithIdFromDecodedFile(decodedFile).map(LinkableResource.literalReferenceOf)
  )

/** The link target of `decodedResource`'s referent under `linkTargetsByReferentKey`; `None` when it is no referent. */
const linkTargetOfDecodedResource = (
  linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>,
  decodedResource: LinkableResource.Type
): Option.Option<LinkTarget.Type> =>
  pipe(
    LinkableResource.tryIntoLogicalReference(decodedResource),
    Option.map(LinkableLogicalReference.key),
    Option.flatMap((referentKey) => HashMap.get(linkTargetsByReferentKey, referentKey))
  )

/**
 * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource of
 * `decodedFile` a stored resource stands in for under `linkTargetsByReferentKey`.
 */
const decodedLiteralReferencesToStoredOf = (
  decodedFile: DecodedFile.DecodedFile,
  linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>
): HashMap.HashMap<string, string> =>
  pipe(
    linkableResourcesWithIdFromDecodedFile(decodedFile),
    Array.filterMap((decodedResource) =>
      pipe(
        linkTargetOfDecodedResource(linkTargetsByReferentKey, decodedResource),
        Option.filter(LinkTarget.is('Stored')),
        Option.map(
          ({ resource: stored }) =>
            [
              LinkableResource.literalReferenceOf(decodedResource),
              LinkableResource.literalReferenceOf(stored),
            ] as const
        )
      )
    ),
    HashMap.fromIterable
  )

/**
 * The plan for `decodedFile` under `linkChoices`: each referent's choice
 * resolved once into its link, and every field read off those links.
 */
const make = (
  decodedFile: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoices.Type
): Type => {
  const referents = Referent.discover(decodedFile)
  const referentsByKey = Referent.byKey(referents)
  const links = referents.map((referent): Link.Type => ({
    referent,
    target: Resolution.linkTargetOf(linkChoices, referentsByKey, referent),
  }))
  const linkTargetsByReferentKey = HashMap.fromIterable(
    links.map(({ referent, target }) => [Referent.key(referent), target] as const)
  )
  return {
    links,
    linkTargetsByReferentKey,
    placedResourcesByPlacedLiteralReference: PlacedResource.byPlacedLiteralReference(
      links,
      literalReferencesFromDecodedFile(decodedFile)
    ),
    decodedLiteralReferencesToStored: decodedLiteralReferencesToStoredOf(
      decodedFile,
      linkTargetsByReferentKey
    ),
  }
}

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
        Option.flatMap((referentKey) => HashMap.get(plan.linkTargetsByReferentKey, referentKey)),
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

export { literalReferencesFromDecodedFile, make, maybePlacedResourceFor, maybeRedirectOf }
export type { Type }
