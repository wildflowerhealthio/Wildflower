/**
 * The link plan: everything placing a decoded file on the identity map needs,
 * worked out once from the file and the reviewer's choices, and the lookups
 * that answer the placement's and the redirection's questions.
 *
 * @remarks
 * A referent's mentions are redirected to its destination. The plan says what
 * each referent's destination is, what the record under each literal
 * reference becomes once it has assumed the identifiers of the referents
 * linked to it, and which decoded literal references move. Built by
 * {@link make}, read through {@link maybeRedirectOf} and
 * {@link maybePlacedRecordFor}, and what the batch lift hands across files.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Destination from './destination.ts'
import type * as IdentityMap from './identity-map.ts'
import type * as Link from './link.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as LogicalReference from './logical-reference.ts'
import * as PlacedRecord from './placed-record.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'

/** The link plan for one decoded file, built once by {@link make}. */
interface Type {
  /**
   * Each referent's destination: where a logical-reference mention is
   * redirected, and which decoded resources a stored record replaces.
   */
  readonly destinationsByReferentKey: ReadonlyMap<string, Destination.Type>
  /**
   * The record under each literal reference the referents land on, as it
   * will be written: what replaces a decoded resource, what a decoded
   * resource assumes, and what the Linked section appends.
   */
  readonly placedRecordsByLiteralReference: ReadonlyMap<string, PlacedRecord.Type>
  /**
   * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource a
   * stored record stands in for, a second resource of the same logical
   * reference under another id included: where a decoded literal reference
   * is redirected, and under which literal reference the resource is written.
   */
  readonly literalReferenceRedirects: ReadonlyMap<string, string>
}

/** The decoded resources of `decodedFile` that have a literal reference, with it. */
const decodedResourcesWithId = (
  decodedFile: DecodedFile.DecodedFile
): readonly LinkableResource.WithId[] =>
  DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
    LinkableResource.is(resource) ? Option.toArray(LinkableResource.tryWithId(resource)) : []
  )

/** The stored record standing in for `decodedResource`: its referent's destination, when that is `Stored`. */
const maybeStoredStandInFor = (
  destinationsByReferentKey: ReadonlyMap<string, Destination.Type>,
  decodedResource: LinkableResource.WithId
): Option.Option<LinkableResource.WithId> =>
  pipe(
    LinkableResource.maybeLogicalReferenceOf(decodedResource),
    Option.flatMapNullable((logicalReference) =>
      destinationsByReferentKey.get(LogicalReference.key(logicalReference))
    ),
    Option.filter(Destination.is('Stored')),
    Option.map(({ resource: stored }) => stored)
  )

/**
 * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource of
 * `decodedFile` a stored record stands in for under `destinationsByReferentKey`.
 */
const literalReferenceRedirectsOf = (
  decodedFile: DecodedFile.DecodedFile,
  destinationsByReferentKey: ReadonlyMap<string, Destination.Type>
): ReadonlyMap<string, string> =>
  new Map(
    decodedResourcesWithId(decodedFile).flatMap((decodedResource) =>
      pipe(
        maybeStoredStandInFor(destinationsByReferentKey, decodedResource),
        Option.map(
          (stored) =>
            [
              LinkableResource.literalReferenceOf(decodedResource),
              LinkableResource.literalReferenceOf(stored),
            ] as const
        ),
        Option.toArray
      )
    )
  )

/**
 * The plan for `decodedFile` under `identityMap`: each referent's choice
 * resolved once into its link, and every field read off those links.
 */
const make = (decodedFile: DecodedFile.DecodedFile, identityMap: IdentityMap.Type): Type => {
  const referents = Referent.discover(decodedFile)
  const referentsByKey = Referent.byKey(referents)
  const links = referents.map((referent): Link.Type => ({
    referent,
    destination: Resolution.destinationOf(identityMap, referentsByKey, referent),
  }))
  const destinationsByReferentKey = new Map(
    links.map(({ referent, destination }) => [Referent.key(referent), destination])
  )
  return {
    destinationsByReferentKey,
    placedRecordsByLiteralReference: PlacedRecord.byLiteralReference(
      links,
      new Set(decodedResourcesWithId(decodedFile).map(LinkableResource.literalReferenceOf))
    ),
    literalReferenceRedirects: literalReferenceRedirectsOf(decodedFile, destinationsByReferentKey),
  }
}

/**
 * The literal reference `referenceAsDecoded` is redirected to under `plan`:
 * for a decoded literal reference, where it moves; for a logical reference,
 * its referent's destination. `None` when it stays as decoded.
 */
const maybeRedirectOf = (
  plan: Type,
  referenceAsDecoded: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  referenceAsDecoded.reference === null
    ? pipe(
        LogicalReference.maybeOfReference(referenceAsDecoded),
        Option.flatMapNullable((logicalReference) =>
          plan.destinationsByReferentKey.get(LogicalReference.key(logicalReference))
        ),
        Option.flatMap(Destination.maybeRecordOf),
        Option.map(LinkableResource.literalReferenceOf)
      )
    : Option.fromNullable(plan.literalReferenceRedirects.get(referenceAsDecoded.reference))

/**
 * The record `decodedResource` is written as under `plan`: the placed record
 * under the literal reference its own is redirected to, which is a stored
 * record's when one stands in for it and its own otherwise. `None` when the
 * plan has no record there, so the resource is written as decoded.
 */
const maybePlacedRecordFor = (
  plan: Type,
  decodedResource: LinkableResource.WithId
): Option.Option<PlacedRecord.Type> => {
  const decodedLiteralReference = LinkableResource.literalReferenceOf(decodedResource)
  const placedLiteralReference =
    plan.literalReferenceRedirects.get(decodedLiteralReference) ?? decodedLiteralReference
  return Option.fromNullable(plan.placedRecordsByLiteralReference.get(placedLiteralReference))
}

export { make, maybePlacedRecordFor, maybeRedirectOf }
export type { Type }
