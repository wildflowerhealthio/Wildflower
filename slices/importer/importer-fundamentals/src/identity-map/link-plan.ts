/**
 * The link plan: everything placing a decoded file on the identity map needs,
 * worked out once from the file and the reviewer's choices.
 *
 * @remarks
 * A referent's mentions are redirected to its destination. The plan says what
 * each referent's destination is, what the record under each literal
 * reference becomes once it has assumed the identifiers of the referents
 * linked to it, and which decoded literal references move. Built by
 * {@link make}, read by the redirect and the placement, and what the batch
 * lift hands across files.
 *
 * @packageDocumentation
 */

import { Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Destination from './destination.ts'
import type * as IdentityMap from './identity-map.ts'
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
   * is redirected.
   */
  readonly literalReferenceRedirects: ReadonlyMap<string, string>
}

/** The literal references the decoded resources of `decodedFile` carry. */
const decodedLiteralReferences = (decodedFile: DecodedFile.DecodedFile): ReadonlySet<string> =>
  new Set(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
      resource.id === null ? [] : [`${resource.resourceType}/${resource.id}`]
    )
  )

/** The destination of `decodedResource`'s referent under `destinationsByReferentKey`, when it is one. */
const maybeDestinationOf = (
  destinationsByReferentKey: ReadonlyMap<string, Destination.Type>,
  decodedResource: LinkableResource.Type
): Option.Option<Destination.Type> =>
  pipe(
    LinkableResource.maybeLogicalReferenceOf(decodedResource),
    Option.flatMapNullable((logicalReference) =>
      destinationsByReferentKey.get(LogicalReference.key(logicalReference))
    )
  )

/** The stored record `decodedResource`'s referent links to under `destinationsByReferentKey`, when it links to one. */
const maybeStoredDestinationOf = (
  destinationsByReferentKey: ReadonlyMap<string, Destination.Type>,
  decodedResource: LinkableResource.Type
): Option.Option<LinkableResource.WithId> =>
  pipe(
    maybeDestinationOf(destinationsByReferentKey, decodedResource),
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
    DecodedFile.resources(decodedFile).flatMap(({ resource }) => {
      if (!LinkableResource.is(resource) || resource.id === null) return []
      const from = LinkableResource.literalReferenceOf({ ...resource, id: resource.id })
      return pipe(
        maybeStoredDestinationOf(destinationsByReferentKey, resource),
        Option.map((stored) => [from, LinkableResource.literalReferenceOf(stored)] as const),
        Option.toArray
      )
    })
  )

/**
 * The plan for `decodedFile` under `identityMap`: each referent's choice
 * resolved once into its link, and every field read off those links.
 */
const make = (decodedFile: DecodedFile.DecodedFile, identityMap: IdentityMap.Type): Type => {
  const referents = Referent.discover(decodedFile)
  const referentsByKey = Referent.byKey(referents)
  const links = referents.map((referent): PlacedRecord.Link => ({
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
      decodedLiteralReferences(decodedFile)
    ),
    literalReferenceRedirects: literalReferenceRedirectsOf(decodedFile, destinationsByReferentKey),
  }
}

export { make, maybeStoredDestinationOf }
export type { Type }
