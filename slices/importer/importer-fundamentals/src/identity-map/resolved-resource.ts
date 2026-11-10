/**
 * A resolved resource: a link target's resource as it will be written, having
 * assumed the identifiers of every referent linked to it, stored or decoded.
 *
 * @remarks
 * One per resolved literal reference, so a stored resource two referents link
 * to, a decoded resource other referents link to, and a decoded resource a
 * mention links to by its stored copy are all the same thing to the
 * resolution: the resource under that literal reference, as written. It is
 * made from the links redirected to it.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Effect, Option, pipe, Record } from 'effect'

import * as LinkTarget from './link-target.ts'
import type * as Link from './link.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as Referent from './referent.ts'

/** The resource under one resolved literal reference, as it will be written. */
interface Type {
  /** The literal reference it is written under, `Type/<id>`. */
  readonly resolvedLiteralReference: string
  /**
   * The copy written, having assumed every identifier its other copies carry
   * and the referents linked to it bring.
   */
  readonly resource: LinkableResource.WithId
  /** The identifiers it assumes: what a decoded copy of it in the file assumes too. */
  readonly identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
  /**
   * Whether a resolved row of the batch holds the resource where a decoded
   * resource was: one decoded under its literal reference and written there,
   * or one a decoded resource is replaced by. When none does, the resource is
   * appended to the batch once so the review and the diff show what it gained.
   */
  readonly resourceExistsInBatch: boolean
  /**
   * What a review shows for it (`LinkableResource.labelOf`, else its literal
   * reference): the title of a row it replaces or is appended as.
   */
  readonly label: string
  /**
   * The referent whose record it is, when the copy written is a record the
   * batch makes: the one whose decoded resource it is. `None` when the copy
   * written is a stored resource.
   */
  readonly ownerReferent: Option.Option<Referent.Type>
}

/**
 * The link whose target holds the copy of the resource under one resolved
 * literal reference that is written: the decoded one when it is a referent's
 * link target, else the last link.
 *
 * @remarks
 * On a re-import a decoded resource and its stored copy share a literal
 * reference: the referent's own search finds the copy under the decoded id
 * (`ReferentSearch.defaultChoice` then updates it with the decode), while a
 * mention the copy answers to links to it as stored. The decode is the newer,
 * so it is the one written. Should two referents carry different stored
 * copies of one resource, the last one's is written.
 */
const writtenLinkOf = (linkedResources: Array.NonEmptyReadonlyArray<Link.Type>): Link.Type =>
  Option.getOrElse(
    Array.findLast(linkedResources, ({ target }) => LinkTarget.is('Decoded')(target)),
    () => Array.lastNonEmpty(linkedResources)
  )

/** The stored copies the links of `linkedResources` update: each `Decoded` target's, when it has one. */
const storedCopiesUpdatedBy = (
  linkedResources: readonly Link.Type[]
): readonly LinkableResource.WithId[] =>
  Array.filterMap(linkedResources, ({ target }) =>
    LinkTarget.is('Decoded')(target) ? target.storedCopy : Option.none()
  )

/**
 * The referent of `linkedResources` whose decoded resource `writtenLink`'s
 * target holds, when that target is `Decoded`, a record the batch makes;
 * `None` for a `Stored` one, which is the device's whatever its id.
 */
const ownerReferentOf = (
  linkedResources: readonly Link.Type[],
  writtenLink: Link.Type
): Option.Option<Referent.Type> =>
  pipe(
    Option.liftPredicate(writtenLink.target, LinkTarget.is('Decoded')),
    Option.flatMap(({ resource }) =>
      Array.findFirst(linkedResources, ({ referent }) =>
        LinkableResource.sameRecord(referent.resource, resource)
      )
    ),
    Option.map(({ referent }) => referent)
  )

/**
 * The resolved resource under `resolvedLiteralReference`, from the links that
 * are redirected to it, given the literal references of the decoded resources the
 * batch writes where they were decoded.
 *
 * @remarks
 * The copy written ({@link writtenLinkOf}) assumes, once, its own derived
 * identifier (so a name-and-birth-date match finds it next time), then the
 * identifiers of every other copy of the resource the links carry: a stored
 * copy another referent links to, and the stored copy a re-import's decode updates
 * (`LinkTarget.Decoded`'s `storedCopy`), so what the copy assumed before is
 * kept; then those of every referent linked to it. This is the one place a
 * copy's identifiers are carried forward.
 */
const make = (
  resolvedLiteralReference: string,
  linkedResources: Array.NonEmptyReadonlyArray<Link.Type>,
  literalReferencesWrittenAsDecoded: readonly string[]
): Effect.Effect<Type> => {
  const writtenLink = writtenLinkOf(linkedResources)
  const resource = writtenLink.target.resource
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
        ...linkedResources.flatMap(({ referent }) => referent.identifiers),
      ]
      return {
        resolvedLiteralReference,
        resource: LinkableResource.assumesIdentifiers(resource, identifiersToAssume),
        identifiersToAssume,
        resourceExistsInBatch:
          Array.contains(literalReferencesWrittenAsDecoded, resolvedLiteralReference) ||
          linkedResources.some(({ target }) => LinkTarget.is('Stored')(target)),
        label,
        ownerReferent: ownerReferentOf(linkedResources, writtenLink),
      }
    })
  )
}

/**
 * One resolved resource per literal reference `links` redirect to, in the
 * order the links first reach it, given the literal references of the
 * decoded resources the batch writes where they were decoded.
 */
const fromLinks = (
  links: readonly Link.Type[],
  literalReferencesWrittenAsDecoded: readonly string[]
): Effect.Effect<readonly Type[]> =>
  pipe(
    links,
    Array.groupBy(({ target }) => LinkableResource.literalReferenceOf(target.resource)),
    Record.toEntries,
    Effect.forEach(([resolvedLiteralReference, linkedResources]) =>
      make(resolvedLiteralReference, linkedResources, literalReferencesWrittenAsDecoded)
    )
  )

export { fromLinks, make }
export type { Type }
