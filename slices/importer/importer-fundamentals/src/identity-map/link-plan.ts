/**
 * The link plan: everything placing a decoded file on the identity map needs,
 * worked out once from the file and the reviewer's choices.
 *
 * @remarks
 * A referent's mentions are redirected to its destination. The plan says what
 * each referent's destination is, what each destination resource becomes once
 * it has assumed the identifiers of the referents linked to it, and which
 * literals move. Built by {@link make}, read by the redirect and the
 * placement, and what the batch lift hands across files.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Destination from './destination.ts'
import * as Identity from './identity.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'

type Identifier = IdentifierAndReference.IdentifierType

/** A stored or provisional resource referents link to, as it will be written. */
interface LinkedResource {
  /** The resource, having assumed every identifier the referents linked to it bring. */
  readonly resource: LinkableResource.WithId
  /** What it assumed: the identifiers a decoded copy of it in the file assumes too. */
  readonly assumed: readonly Identifier[]
  /**
   * Whether the file holds no resource for it, only mentions: linked to by
   * referents without a resource alone, and under a literal no decoded
   * resource carries. Such a resource is appended to the file, so the review
   * and the diff show what it gained.
   */
  readonly existsOnlyAsMentionInFile: boolean
}

/** The link plan for one decoded file, built once by {@link make}. */
interface Type {
  /**
   * Each referent's destination, by `Referent.key`: where an identifier-only
   * mention is redirected, and which decoded resources a stored one replaces.
   */
  readonly destinations: ReadonlyMap<string, Destination.Type>
  /**
   * Each stored or provisional destination resource, by its literal, as it
   * will be written: what replaces a decoded resource, and what the Linked
   * section appends.
   */
  readonly linkedResources: ReadonlyMap<string, LinkedResource>
  /**
   * `Type/<source id>` → `Type/<stored id>` for every decoded resource a stored
   * one stands in for, a second resource of the same identity under another id
   * included: where a literal mention is redirected.
   */
  readonly literalRedirects: ReadonlyMap<string, string>
  /**
   * What a referent's own resource assumes, by `Referent.key`: the identifiers
   * of the referents linked to it, its own included.
   */
  readonly assumedByOwnResource: ReadonlyMap<string, readonly Identifier[]>
}

/** A referent with the destination its choice resolved to. */
interface ResolvedReferent {
  readonly referent: Referent.Type
  readonly destination: Destination.Type
}

/** The literals the decoded resources of `decodedFile` carry. */
const literalsHeldBy = (decodedFile: DecodedFile.DecodedFile): ReadonlySet<string> =>
  new Set(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
      resource.id === null ? [] : [`${resource.resourceType}/${resource.id}`]
    )
  )

/** The stored resource `decodedResource`'s referent links to under `destinations`, when it links to one. */
const storedDestinationOf = (
  destinations: ReadonlyMap<string, Destination.Type>,
  decodedResource: LinkableResource.Type
): Option.Option<LinkableResource.WithId> =>
  pipe(
    LinkableResource.identityOf(decodedResource),
    Option.flatMapNullable((identity) => destinations.get(Identity.key(identity))),
    Option.filter(Destination.is('OnStoredResource')),
    Option.map(({ resource: stored }) => stored)
  )

/** The stored or provisional resource `destination` links to, when it is one of those. */
const linkedResourceOf = (destination: Destination.Type): Option.Option<LinkableResource.WithId> =>
  Destination.match(destination, {
    OnStoredResource: ({ resource }) => Option.some(resource),
    OnProvisionalResource: ({ resource }) => Option.some(resource),
    OnOwnResource: () => Option.none(),
    Unlinked: () => Option.none(),
  })

/**
 * Each stored or provisional resource the referents link to, by its literal,
 * as it will be written.
 *
 * @remarks
 * It assumes, once, its own derived identifier (so a name-and-birth-date
 * match finds it next time, and so a second placement adds nothing) and then
 * the identifiers of every referent linked to it. Should two referents carry
 * different copies of one stored resource, the last one's is written.
 */
const linkedResourcesOf = (
  decodedFile: DecodedFile.DecodedFile,
  resolved: readonly ResolvedReferent[]
): ReadonlyMap<string, LinkedResource> => {
  const held = literalsHeldBy(decodedFile)
  const links = resolved.flatMap(({ referent, destination }) =>
    pipe(
      linkedResourceOf(destination),
      Option.map((resource) => ({ referent, resource })),
      Option.toArray
    )
  )
  const linksByLiteral = Array.groupBy(links, ({ resource }) =>
    LinkableResource.literalOf(resource)
  )
  return new Map(
    Object.entries(linksByLiteral).map(([literal, linksToLiteral]): [string, LinkedResource] => {
      const { resource } = Array.lastNonEmpty(linksToLiteral)
      const assumed = [
        ...Option.toArray(LinkableResource.derivedIdentifier(resource)),
        ...linksToLiteral.flatMap(({ referent }) => Referent.identifiersOf(referent)),
      ]
      return [
        literal,
        {
          resource: LinkableResource.assumesIdentifiers(resource, assumed),
          assumed,
          existsOnlyAsMentionInFile:
            !held.has(literal) &&
            linksToLiteral.every(({ referent }) => Referent.is('ByMentionOnly')(referent)),
        },
      ]
    })
  )
}

/**
 * `Type/<source id>` → `Type/<stored id>` for every decoded resource of
 * `decodedFile` a stored one stands in for under `destinations`.
 */
const literalRedirectsOf = (
  decodedFile: DecodedFile.DecodedFile,
  destinations: ReadonlyMap<string, Destination.Type>
): ReadonlyMap<string, string> =>
  new Map(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) => {
      if (!LinkableResource.is(resource) || resource.id === null) return []
      const from = LinkableResource.literalOf({ ...resource, id: resource.id })
      return pipe(
        storedDestinationOf(destinations, resource),
        Option.map((stored) => [from, LinkableResource.literalOf(stored)] as const),
        Option.toArray
      )
    })
  )

/**
 * {@link Type.assumedByOwnResource}: for each referent on its own resource,
 * the identifiers of every referent linked to it.
 */
const assumedByOwnResourceOf = (
  resolved: readonly ResolvedReferent[]
): ReadonlyMap<string, readonly Identifier[]> => {
  const links = resolved.flatMap(({ referent, destination }) =>
    Destination.match(destination, {
      OnOwnResource: ({ referent: own }) => [{ ownKey: Referent.key(own), referent }],
      OnStoredResource: () => [],
      OnProvisionalResource: () => [],
      Unlinked: () => [],
    })
  )
  return new Map(
    Object.entries(Array.groupBy(links, ({ ownKey }) => ownKey)).map(([ownKey, linksToOwn]) => [
      ownKey,
      linksToOwn.flatMap(({ referent }) => Referent.identifiersOf(referent)),
    ])
  )
}

/**
 * The plan for `decodedFile` under `choices`: each referent's choice resolved
 * once, and every field read off those destinations.
 */
const make = (decodedFile: DecodedFile.DecodedFile, choices: LinkChoice.ByReferent): Type => {
  const referents = Referent.discover(decodedFile)
  const indexed = Referent.index(referents)
  const resolved = referents.map((referent): ResolvedReferent => ({
    referent,
    destination: Resolution.destinationOf(choices, indexed, referent),
  }))
  const destinations = new Map(
    resolved.map(({ referent, destination }) => [Referent.key(referent), destination])
  )
  return {
    destinations,
    linkedResources: linkedResourcesOf(decodedFile, resolved),
    literalRedirects: literalRedirectsOf(decodedFile, destinations),
    assumedByOwnResource: assumedByOwnResourceOf(resolved),
  }
}

export { make, storedDestinationOf }
export type { LinkedResource, Type }
