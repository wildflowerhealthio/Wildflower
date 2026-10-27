/**
 * A placed resource: a link target's resource as it will be written, having
 * assumed the identifiers of every referent linked to it, whatever its
 * origin.
 *
 * @remarks
 * One per placed literal reference, so a stored resource two referents link
 * to, a provisional one, a decoded resource other referents link to, and a
 * decoded resource a mention links to by its stored copy are all the same
 * thing to the placement: the resource under that literal reference, as
 * written.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Effect, HashMap, HashSet, Option, pipe, Record } from 'effect'

import * as LinkTarget from './link-target.ts'
import * as Link from './link.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** The resource under one placed literal reference, as it will be written. */
interface Type {
  /**
   * The copy written, having assumed every identifier its other copies carry
   * and the referents linked to it bring.
   */
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
 * The copy of the resource under one placed literal reference that is
 * written: the decoded one when a referent's link lands on it, else the last
 * link's.
 *
 * @remarks
 * On a re-import a decoded resource and its stored copy share a literal
 * reference: the referent's own search finds the copy under the decoded id
 * (`ReferentSearch.defaultChoice` then creates the resource), while a mention
 * the copy answers to links to it as stored. The decode is the newer, so it
 * is the one written. Should two referents carry different stored copies of
 * one resource, the last one's is written.
 */
const writtenCopyOf = (
  linkedResources: Array.NonEmptyReadonlyArray<Link.LinkedResource>
): LinkableResource.WithId =>
  pipe(
    Array.findLast(linkedResources, ({ target }) => LinkTarget.is('Decoded')(target)),
    Option.getOrElse(() => Array.lastNonEmpty(linkedResources)),
    ({ target }) => target.resource
  )

/**
 * The placed resource under `placedLiteralReference`, from the links that
 * landed on it, given the literal references the batch's decoded resources
 * carry.
 *
 * @remarks
 * The copy written ({@link writtenCopyOf}) assumes, once, its own derived
 * identifier (so a name-and-birth-date match finds it next time), then the
 * identifiers of every other copy linked under the literal reference (a
 * stored copy's, on a re-import, so what it assumed before is kept), then
 * those of every referent linked to it.
 */
const make = (
  placedLiteralReference: string,
  linkedResources: Array.NonEmptyReadonlyArray<Link.LinkedResource>,
  decodedLiteralReferences: HashSet.HashSet<string>
): Effect.Effect<Type> => {
  const resource = writtenCopyOf(linkedResources)
  return Effect.all({
    derivedIdentifier: LinkableResource.maybeDerivedIdentifier(resource),
    label: LinkableResource.labelOf(resource, placedLiteralReference),
  }).pipe(
    Effect.map(({ derivedIdentifier, label }) => {
      const identifiersToAssume = [
        ...Option.toArray(derivedIdentifier),
        ...linkedResources.flatMap(({ target }) => target.resource.identifier),
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
    Array.groupBy(({ target }) => LinkableResource.literalReferenceOf(target.resource)),
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
