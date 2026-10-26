/**
 * The link plan: everything placing a decoded file on the identity map needs,
 * worked out once from the file and the reviewer's choices.
 *
 * @remarks
 * A referent's mentions are redirected to its destination. The plan says what
 * each referent's destination is, what each destination record becomes once
 * it has assumed the identifiers of the referents linked to it, and which
 * literal references move. Built by {@link make}, read by the redirect and
 * the placement, and what the batch lift hands across files.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Destination from './destination.ts'
import type * as IdentityMap from './identity-map.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as LogicalReference from './logical-reference.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'

type Identifier = IdentifierAndReference.IdentifierType

/**
 * A stored or provisional record referents link to, as it will be written. A
 * decoded record is a destination too, but is written where it was decoded
 * rather than through one of these.
 */
interface DestinationResource {
  /** The record, having assumed every identifier the referents linked to it bring. */
  readonly resource: LinkableResource.WithId
  /** The identifiers it assumes: what a decoded copy of it in the file assumes too. */
  readonly identifiersToAssume: readonly Identifier[]
  /**
   * Whether the file holds a decoded resource under its literal reference.
   * When it does not, and only referents without a resource link to it, the
   * record is appended to the file so the review and the diff show what it
   * gained.
   */
  readonly resourceExistsInFile: boolean
}

/** The link plan for one decoded file, built once by {@link make}. */
interface Type {
  /**
   * Each referent's destination: where an identifier-only mention is
   * redirected, and which decoded resources a stored record replaces.
   */
  readonly destinationsByReferentKey: ReadonlyMap<string, Destination.Type>
  /**
   * Each stored or provisional destination record, as it will be written:
   * what replaces a decoded resource, and what the Linked section appends.
   */
  readonly destinationResourcesByLiteralReference: ReadonlyMap<string, DestinationResource>
  /**
   * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource a
   * stored record stands in for, a second resource of the same identity under
   * another id included: where a decoded literal reference is redirected.
   */
  readonly literalReferenceRedirects: ReadonlyMap<string, string>
  /**
   * What a referent's decoded resource assumes: the identifiers of the
   * referents linked to it, its own included.
   */
  readonly identifiersToAssumeByReferentKey: ReadonlyMap<string, readonly Identifier[]>
}

/** A link: a referent with the destination its choice resolved to. */
interface Link {
  readonly referent: Referent.Type
  readonly destination: Destination.Type
}

/** The literal references the decoded resources of `decodedFile` carry. */
const decodedLiteralReferences = (decodedFile: DecodedFile.DecodedFile): ReadonlySet<string> =>
  new Set(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
      resource.id === null ? [] : [`${resource.resourceType}/${resource.id}`]
    )
  )

/** The stored record `decodedResource`'s referent links to under `destinationsByReferentKey`, when it links to one. */
const maybeStoredDestinationOf = (
  destinationsByReferentKey: ReadonlyMap<string, Destination.Type>,
  decodedResource: LinkableResource.Type
): Option.Option<LinkableResource.WithId> =>
  pipe(
    LinkableResource.maybeLogicalReferenceOf(decodedResource),
    Option.flatMapNullable((logicalReference) =>
      destinationsByReferentKey.get(LogicalReference.key(logicalReference))
    ),
    Option.filter(Destination.is('Stored')),
    Option.map(({ resource: stored }) => stored)
  )

/** The stored or provisional record `destination` links to, when it is one of those. */
const maybeDestinationResourceOf = (
  destination: Destination.Type
): Option.Option<LinkableResource.WithId> =>
  Destination.match(destination, {
    Stored: ({ resource }) => Option.some(resource),
    Provisional: ({ resource }) => Option.some(resource),
    Decoded: () => Option.none(),
    Unlinked: () => Option.none(),
  })

/**
 * Each stored or provisional record the referents link to, by its literal
 * reference, as it will be written.
 *
 * @remarks
 * It assumes, once, its own derived identifier (so a name-and-birth-date
 * match finds it next time, and so a second placement adds nothing) and then
 * the identifiers of every referent linked to it. Should two referents carry
 * different copies of one stored record, the last one's is written.
 */
const destinationResourcesOf = (
  decodedFile: DecodedFile.DecodedFile,
  links: readonly Link[]
): ReadonlyMap<string, DestinationResource> => {
  const decoded = decodedLiteralReferences(decodedFile)
  const linksToResources = links.flatMap(({ referent, destination }) =>
    pipe(
      maybeDestinationResourceOf(destination),
      Option.map((resource) => ({ referent, resource })),
      Option.toArray
    )
  )
  const linksByLiteralReference = Array.groupBy(linksToResources, ({ resource }) =>
    LinkableResource.literalReferenceOf(resource)
  )
  return new Map(
    Object.entries(linksByLiteralReference).map(
      ([literalReference, linksToResource]): [string, DestinationResource] => {
        const { resource } = Array.lastNonEmpty(linksToResource)
        const identifiersToAssume = [
          ...Option.toArray(LinkableResource.maybeDerivedIdentifier(resource)),
          ...linksToResource.flatMap(({ referent }) => Referent.identifiersOf(referent)),
        ]
        return [
          literalReference,
          {
            resource: LinkableResource.assumesIdentifiers(resource, identifiersToAssume),
            identifiersToAssume,
            resourceExistsInFile:
              decoded.has(literalReference) ||
              linksToResource.some(({ referent }) => Referent.is('AsResource')(referent)),
          },
        ]
      }
    )
  )
}

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
 * {@link Type.identifiersToAssumeByReferentKey}: for each referent on its
 * decoded resource, the identifiers of every referent linked to it.
 */
const identifiersToAssumeByReferentKeyOf = (
  links: readonly Link[]
): ReadonlyMap<string, readonly Identifier[]> => {
  const linksToDecoded = links.flatMap(({ referent, destination }) =>
    Destination.match(destination, {
      Decoded: ({ referent: decoded }) => [{ decodedKey: Referent.key(decoded), referent }],
      Stored: () => [],
      Provisional: () => [],
      Unlinked: () => [],
    })
  )
  return new Map(
    Object.entries(Array.groupBy(linksToDecoded, ({ decodedKey }) => decodedKey)).map(
      ([decodedKey, linksToOne]) => [
        decodedKey,
        linksToOne.flatMap(({ referent }) => Referent.identifiersOf(referent)),
      ]
    )
  )
}

/**
 * The plan for `decodedFile` under `identityMap`: each referent's choice
 * resolved once, and every field read off those links.
 */
const make = (decodedFile: DecodedFile.DecodedFile, identityMap: IdentityMap.Type): Type => {
  const referents = Referent.discover(decodedFile)
  const referentsByKey = Referent.byKey(referents)
  const links = referents.map((referent): Link => ({
    referent,
    destination: Resolution.destinationOf(identityMap, referentsByKey, referent),
  }))
  const destinationsByReferentKey = new Map(
    links.map(({ referent, destination }) => [Referent.key(referent), destination])
  )
  return {
    destinationsByReferentKey,
    destinationResourcesByLiteralReference: destinationResourcesOf(decodedFile, links),
    literalReferenceRedirects: literalReferenceRedirectsOf(decodedFile, destinationsByReferentKey),
    identifiersToAssumeByReferentKey: identifiersToAssumeByReferentKeyOf(links),
  }
}

export { make, maybeStoredDestinationOf }
export type { DestinationResource, Link, Type }
