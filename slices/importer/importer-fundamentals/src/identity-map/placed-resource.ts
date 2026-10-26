/**
 * A placed resource: a link target's resource as it will be written, having
 * assumed the identifiers of every referent linked to it, whatever its
 * origin.
 *
 * @remarks
 * One per placed literal reference, so a stored resource two referents link
 * to, a provisional one, and a decoded resource other referents link to are
 * all the same thing to the placement: the resource under that literal
 * reference, as written.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, HashMap, HashSet, Option, pipe, Record } from 'effect'

import * as LinkTarget from './link-target.ts'
import type * as Link from './link.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** The resource under one placed literal reference, as it will be written. */
interface Type {
  /** The resource, having assumed every identifier the referents linked to it bring. */
  readonly resource: LinkableResource.WithId
  /** The identifiers it assumes: what a decoded copy of it in the file assumes too. */
  readonly identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
  /**
   * Whether the placed file holds the resource where a decoded resource was:
   * one decoded under its literal reference, or one a decoded resource is
   * replaced by. When it does not, the resource is appended to the file so
   * the review and the diff show what it gained.
   */
  readonly resourceExistsInFile: boolean
}

/** A link that landed on a resource: the referent, and the resource its target holds. */
interface LinkedResource {
  readonly referent: Referent.Type
  readonly resource: LinkableResource.WithId
}

/** The links of `links` whose target holds a resource. */
const linkedResourcesOf = (links: readonly Link.Type[]): readonly LinkedResource[] =>
  Array.filterMap(links, ({ referent, target }) =>
    Option.map(LinkTarget.tryIntoResource(target), (resource) => ({ referent, resource }))
  )

/**
 * The placed resource under `placedLiteralReference`, from the links that
 * landed on it.
 *
 * @remarks
 * A resource assumes, once, its own derived identifier (so a name-and-birth-date
 * match finds it next time, and so a second placement adds nothing) and then
 * the identifiers of every referent linked to it. Should two referents carry
 * different copies of one stored resource, the last one's is written.
 */
const placedResourceOf = (
  placedLiteralReference: string,
  linkedResources: Array.NonEmptyReadonlyArray<LinkedResource>,
  decodedLiteralReferences: HashSet.HashSet<string>
): Type => {
  const { resource } = Array.lastNonEmpty(linkedResources)
  const identifiersToAssume = [
    ...Option.toArray(LinkableResource.maybeDerivedIdentifier(resource)),
    ...linkedResources.flatMap(({ referent }) => Referent.identifiersOf(referent)),
  ]
  return {
    resource: LinkableResource.assumesIdentifiers(resource, identifiersToAssume),
    identifiersToAssume,
    resourceExistsInFile:
      HashSet.has(decodedLiteralReferences, placedLiteralReference) ||
      linkedResources.some(({ referent }) => Referent.is('AsResource')(referent)),
  }
}

/**
 * The placed resource under each literal reference the links land on, given
 * the literal references the file's decoded resources carry.
 */
const byPlacedLiteralReference = (
  links: readonly Link.Type[],
  decodedLiteralReferences: HashSet.HashSet<string>
): HashMap.HashMap<string, Type> =>
  pipe(
    linkedResourcesOf(links),
    Array.groupBy(({ resource }) => LinkableResource.literalReferenceOf(resource)),
    Record.map((linkedResources, placedLiteralReference) =>
      placedResourceOf(placedLiteralReference, linkedResources, decodedLiteralReferences)
    ),
    Record.toEntries,
    HashMap.fromIterable
  )

export { byPlacedLiteralReference }
export type { Type }
