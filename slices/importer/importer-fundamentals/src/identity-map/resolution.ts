/**
 * Resolving a referent's choice into its destination, following
 * `LinkToReferent` choices to the end.
 *
 * @packageDocumentation
 */

import { Array, Option, Order, pipe } from 'effect'

import * as Destination from './destination.ts'
import type * as IdentityMap from './identity-map.ts'
import * as LinkChoice from './link-choice.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** What `Create` comes to for `referent`: its decoded resource, a provisional record for its logical reference, else nothing. */
const createFor = (referent: Referent.Type): Destination.Type =>
  Referent.match(referent, {
    AsResource: ({ resource }) => Destination.Decoded({ resource }),
    ByMentionOnly: ({ logicalReference }) =>
      Option.match(LinkableResource.maybeProvisionalFor(logicalReference), {
        onNone: () => Destination.Unlinked(),
        onSome: (resource) => Destination.Provisional({ resource }),
      }),
  })

/** A choice the referent's kind does not allow reads as its default: its decoded resource, or nothing. */
const defaultFor = (referent: Referent.Type): Destination.Type =>
  Referent.match(referent, {
    AsResource: ({ resource }) => Destination.Decoded({ resource }),
    ByMentionOnly: () => Destination.Unlinked(),
  })

const sameType = (referent: Referent.Type, resource: { readonly resourceType: string }): boolean =>
  resource.resourceType === referent.logicalReference.type

/**
 * Where a `LinkToReferent` cycle comes to, whichever member the walk entered
 * at: `Create` for the first member, in key order, that `Create` places on a
 * record, else unlinked. One destination for the whole cycle, since the
 * reviewer said its members are one.
 */
const destinationOfCycle = (cycle: readonly Referent.Type[]): Destination.Type =>
  pipe(
    Array.sort(cycle, Order.mapInput(Order.string, Referent.key)),
    Array.map(createFor),
    Array.findFirst((destination) => !Destination.is('Unlinked')(destination)),
    Option.getOrElse(() => Destination.Unlinked())
  )

/**
 * The destination `current`'s choice comes to, `path` being the referents
 * walked to reach it, `current` last.
 */
const resolveFrom = (
  identityMap: IdentityMap.Type,
  referents: ReadonlyMap<string, Referent.Type>,
  path: readonly Referent.Type[],
  current: Referent.Type
): Destination.Type =>
  LinkChoice.match(LinkChoice.forReferent(identityMap, current), {
    Create: () => createFor(current),
    DontLink: () => defaultFor(current),
    LinkToStored: ({ resource }) =>
      sameType(current, resource) ? Destination.Stored({ resource }) : defaultFor(current),
    LinkToReferent: ({ referentKey }) =>
      Referent.match(current, {
        AsResource: () => defaultFor(current),
        ByMentionOnly: (byMentionOnly) =>
          followLinkToReferent(identityMap, referents, path, byMentionOnly, referentKey),
      }),
  })

/**
 * Where `current`'s link to the referent keyed `linkedKey` comes to: that
 * referent's destination, or the cycle's when the walk has been there.
 */
const followLinkToReferent = (
  identityMap: IdentityMap.Type,
  referents: ReadonlyMap<string, Referent.Type>,
  path: readonly Referent.Type[],
  current: Referent.ByMentionOnly,
  linkedKey: string
): Destination.Type => {
  const linked = referents.get(linkedKey)
  // A referent of another type is an impossible link: a `subject` never lands on a Practitioner.
  if (linked === undefined || !sameType(current, { resourceType: linked.logicalReference.type })) {
    return Destination.Unlinked()
  }
  const cycleStart = path.findIndex((walked) => Referent.key(walked) === linkedKey)
  return cycleStart === -1
    ? resolveFrom(identityMap, referents, [...path, linked], linked)
    : destinationOfCycle(path.slice(cycleStart))
}

/**
 * The destination `referent` comes to under `identityMap`, given every
 * referent of the file keyed by `Referent.key`.
 *
 * @remarks
 * A choice the referent's kind does not allow reads as its default: a referent
 * with a resource choosing `LinkToReferent`, `DontLink` or a stored record of
 * another type is on its decoded resource; one named only by mentions choosing
 * a stored record of another type, a referent of another type, or one the
 * file does not hold is unlinked. `Create` on a referent named only by
 * mentions is provisional when its logical reference allows it and unlinked
 * otherwise.
 * A `LinkToReferent` cycle resolves to `Create` for the first of its members,
 * in key order, that `Create` places on a record, whichever member is
 * resolved, so every referent in it lands on the same one record.
 */
const destinationOf = (
  identityMap: IdentityMap.Type,
  referents: ReadonlyMap<string, Referent.Type>,
  referent: Referent.Type
): Destination.Type => resolveFrom(identityMap, referents, [referent], referent)

export { destinationOf }
