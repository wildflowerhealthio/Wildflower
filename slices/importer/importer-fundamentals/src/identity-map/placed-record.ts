/**
 * A placed record: a destination record as it will be written, having assumed
 * the identifiers of every referent linked to it, whatever its origin.
 *
 * @remarks
 * One per literal reference, so a stored record two referents link to, a
 * provisional one, and a decoded resource other referents link to are all
 * the same thing to the placement: the record under that literal reference,
 * as written.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array, Option, pipe } from 'effect'

import * as Destination from './destination.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** A link: a referent with the destination its choice resolved to. */
interface Link {
  readonly referent: Referent.Type
  readonly destination: Destination.Type
}

/** The record under one literal reference, as it will be written. */
interface Type {
  /** The record, having assumed every identifier the referents linked to it bring. */
  readonly resource: LinkableResource.WithId
  /** The identifiers it assumes: what a decoded copy of it in the file assumes too. */
  readonly identifiersToAssume: readonly IdentifierAndReference.IdentifierType[]
  /**
   * Whether the placed file holds the record where a decoded resource was:
   * one decoded under its literal reference, or one a decoded resource is
   * replaced by. When it does not, the record is appended to the file so the
   * review and the diff show what it gained.
   */
  readonly resourceExistsInFile: boolean
}

/**
 * The placed record under each literal reference the links land on, given
 * the literal references the file's decoded resources carry.
 *
 * @remarks
 * A record assumes, once, its own derived identifier (so a name-and-birth-date
 * match finds it next time, and so a second placement adds nothing) and then
 * the identifiers of every referent linked to it. Should two referents carry
 * different copies of one stored record, the last one's is written.
 */
const byLiteralReference = (
  links: readonly Link[],
  decodedLiteralReferences: ReadonlySet<string>
): ReadonlyMap<string, Type> => {
  const linksToRecords = links.flatMap(({ referent, destination }) =>
    pipe(
      Destination.maybeRecordOf(destination),
      Option.map((resource) => ({ referent, resource })),
      Option.toArray
    )
  )
  const linksByLiteralReference = Array.groupBy(linksToRecords, ({ resource }) =>
    LinkableResource.literalReferenceOf(resource)
  )
  return new Map(
    Object.entries(linksByLiteralReference).map(
      ([literalReference, linksToRecord]): [string, Type] => {
        const { resource } = Array.lastNonEmpty(linksToRecord)
        const identifiersToAssume = [
          ...Option.toArray(LinkableResource.maybeDerivedIdentifier(resource)),
          ...linksToRecord.flatMap(({ referent }) => Referent.identifiersOf(referent)),
        ]
        return [
          literalReference,
          {
            resource: LinkableResource.assumesIdentifiers(resource, identifiersToAssume),
            identifiersToAssume,
            resourceExistsInFile:
              decodedLiteralReferences.has(literalReference) ||
              linksToRecord.some(({ referent }) => Referent.is('AsResource')(referent)),
          },
        ]
      }
    )
  )
}

export { byLiteralReference }
export type { Link, Type }
