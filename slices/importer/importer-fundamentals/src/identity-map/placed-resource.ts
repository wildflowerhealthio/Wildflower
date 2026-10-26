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
import { Array, Effect, HashMap, HashSet, Option, pipe, Record } from 'effect'

import * as Link from './link.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** The resource under one placed literal reference, as it will be written. */
interface Type {
  /** The resource, having assumed every identifier the referents linked to it bring. */
  readonly resource: LinkableResource.WithId
  /** The identifiers it assumes: what a decoded copy of it in the file assumes too. */
  readonly identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
  /**
   * Whether a placed file of the batch holds the resource where a decoded
   * resource was: one decoded under its literal reference, or one a decoded
   * resource is replaced by. When none does, the resource is appended to the
   * batch once so the review and the diff show what it gained.
   */
  readonly resourceExistsInBatch: boolean
  /**
   * What a review shows for it (`LinkableResource.labelOf`, else its literal
   * reference): the title of an entry it replaces or is appended as.
   */
  readonly label: string
}

/**
 * The placed resource under `placedLiteralReference`, from the links that
 * landed on it, given the literal references the batch's decoded resources
 * carry.
 *
 * @remarks
 * A resource assumes, once, its own derived identifier (so a name-and-birth-date
 * match finds it next time) and then
 * the identifiers of every referent linked to it. Should two referents carry
 * different copies of one stored resource, the last one's is written.
 */
const make = (
  placedLiteralReference: string,
  linkedResources: Array.NonEmptyReadonlyArray<Link.LinkedResource>,
  decodedLiteralReferences: HashSet.HashSet<string>
): Effect.Effect<Type> => {
  const { resource } = Array.lastNonEmpty(linkedResources)
  return Effect.all({
    derivedIdentifier: LinkableResource.maybeDerivedIdentifier(resource),
    label: LinkableResource.labelOf(resource, placedLiteralReference),
  }).pipe(
    Effect.map(({ derivedIdentifier, label }) => {
      const identifiersToAssume = [
        ...Option.toArray(derivedIdentifier),
        ...linkedResources.flatMap(({ referent }) => Referent.identifiersOf(referent)),
      ]
      return {
        resource: LinkableResource.assumesIdentifiers(resource, identifiersToAssume),
        identifiersToAssume,
        resourceExistsInBatch:
          HashSet.has(decodedLiteralReferences, placedLiteralReference) ||
          linkedResources.some(({ referent }) => Referent.is('AsResource')(referent)),
        label,
      }
    })
  )
}

/**
 * The placed resource under each literal reference the links land on, given
 * the literal references the batch's decoded resources carry.
 */
const byPlacedLiteralReference = (
  links: readonly Link.Type[],
  decodedLiteralReferences: HashSet.HashSet<string>
): Effect.Effect<HashMap.HashMap<string, Type>> =>
  pipe(
    links,
    Array.filterMap(Link.tryIntoLinkedResource),
    Array.groupBy(({ resource }) => LinkableResource.literalReferenceOf(resource)),
    Record.toEntries,
    Effect.forEach(([placedLiteralReference, linkedResources]) =>
      Effect.map(
        make(placedLiteralReference, linkedResources, decodedLiteralReferences),
        (placedResource) => [placedLiteralReference, placedResource] as const
      )
    ),
    Effect.map(HashMap.fromIterable)
  )

export { byPlacedLiteralReference, make }
export type { Type }
