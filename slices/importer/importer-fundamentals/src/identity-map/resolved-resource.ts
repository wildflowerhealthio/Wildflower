/**
 * A resolved resource: a link target's resource as it will be written, having
 * assumed the identifiers of every referent linked to it, whatever its
 * origin.
 *
 * @remarks
 * One per resolved literal reference, so a stored resource two referents link
 * to, a provisional one, a decoded resource other referents link to, and a
 * decoded resource a mention links to by its stored copy are all the same
 * thing to the resolution: the resource under that literal reference, as
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

/** The resource under one resolved literal reference, as it will be written. */
interface Type {
  /**
   * The copy written, having assumed every identifier its other copies carry
   * and the referents linked to it bring.
   */
  readonly resource: LinkableResource.WithId
  /** The identifiers it assumes: what a decoded copy of it in the file assumes too. */
  readonly identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
  /**
   * Whether a resolved file of the batch holds the resource where a decoded
   * resource was: one decoded under its literal reference and written there,
   * or one a decoded resource is replaced by. When none does, the resource is
   * appended to the batch once so the review and the diff show what it gained.
   */
  readonly resourceExistsInBatch: boolean
  /**
   * What a review shows for it (`LinkableResource.labelOf`, else its literal
   * reference): the title of an entry it replaces or is appended as.
   */
  readonly label: string
}

/**
 * The copy of the resource under one resolved literal reference that is
 * written: the decoded one when a referent's link lands on it, else the last
 * link's.
 *
 * @remarks
 * On a re-import a decoded resource and its stored copy share a literal
 * reference: the referent's own search finds the copy under the decoded id
 * (`ReferentSearch.defaultChoice` then updates it with the decode), while a
 * mention the copy answers to links to it as stored. The decode is the newer,
 * so it is the one written. Should two referents carry different stored
 * copies of one resource, the last one's is written.
 */
const writtenCopyOf = (
  linkedResources: Array.NonEmptyReadonlyArray<Link.LinkedResource>
): LinkableResource.WithId =>
  pipe(
    Array.findLast(linkedResources, ({ target }) => LinkTarget.is('Decoded')(target)),
    Option.getOrElse(() => Array.lastNonEmpty(linkedResources)),
    ({ target }) => target.resource
  )

/** The stored copies the links of `linkedResources` update: each `Decoded` target's, when it has one. */
const storedCopiesUpdatedBy = (
  linkedResources: readonly Link.LinkedResource[]
): readonly LinkableResource.WithId[] =>
  Array.filterMap(linkedResources, ({ target }) =>
    LinkTarget.is('Decoded')(target) ? target.storedCopy : Option.none()
  )

/**
 * The resolved resource under `resolvedLiteralReference`, from the links that
 * landed on it, given the literal references of the decoded resources the
 * batch writes where they were decoded.
 *
 * @remarks
 * The copy written ({@link writtenCopyOf}) assumes, once, its own derived
 * identifier (so a name-and-birth-date match finds it next time), then the
 * identifiers of every other copy of the resource the links carry: a stored
 * copy a mention links to, and the stored copy a re-import's decode updates
 * (`LinkTarget.Decoded`'s `storedCopy`), so what the copy assumed before is
 * kept; then those of every referent linked to it. This is the one place a
 * copy's identifiers are carried forward.
 */
const make = (
  resolvedLiteralReference: string,
  linkedResources: Array.NonEmptyReadonlyArray<Link.LinkedResource>,
  literalReferencesWrittenAsDecoded: HashSet.HashSet<string>
): Effect.Effect<Type> => {
  const resource = writtenCopyOf(linkedResources)
  return Effect.all({
    derivedIdentifier: LinkableResource.maybeDerivedIdentifier(resource),
    label: LinkableResource.labelOf(resource, resolvedLiteralReference),
  }).pipe(
    Effect.map(({ derivedIdentifier, label }) => {
      const otherCopies = [
        ...linkedResources.flatMap(({ target }) =>
          target.resource === resource ? [] : [target.resource]
        ),
        ...storedCopiesUpdatedBy(linkedResources),
      ]
      const identifiersToAssume = [
        ...Option.toArray(derivedIdentifier),
        ...otherCopies.flatMap((copy) => copy.identifier),
        ...linkedResources.flatMap(({ referent }) => Referent.identifiersOf(referent)),
      ]
      return {
        resource: LinkableResource.assumesIdentifiers(resource, identifiersToAssume),
        identifiersToAssume,
        resourceExistsInBatch:
          HashSet.has(literalReferencesWrittenAsDecoded, resolvedLiteralReference) ||
          linkedResources.some(({ referent }) => Referent.is('AsResource')(referent)),
        label,
      }
    })
  )
}

/**
 * The resolved resource under each literal reference the links land on, given
 * the literal references of the decoded resources the batch writes where they
 * were decoded.
 */
const byResolvedLiteralReference = (
  links: readonly Link.Type[],
  literalReferencesWrittenAsDecoded: HashSet.HashSet<string>
): Effect.Effect<HashMap.HashMap<string, Type>> =>
  pipe(
    links,
    Array.filterMap(Link.tryIntoLinkedResource),
    Array.groupBy(({ target }) => LinkableResource.literalReferenceOf(target.resource)),
    Record.toEntries,
    Effect.forEach(([resolvedLiteralReference, linkedResources]) =>
      Effect.map(
        make(resolvedLiteralReference, linkedResources, literalReferencesWrittenAsDecoded),
        (resolvedResource) => [resolvedLiteralReference, resolvedResource] as const
      )
    ),
    Effect.map(HashMap.fromIterable)
  )

export { byResolvedLiteralReference, make }
export type { Type }
