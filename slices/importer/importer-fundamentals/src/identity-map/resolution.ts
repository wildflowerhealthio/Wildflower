/**
 * Resolving a referent's choice into its destination, following `SameAs`
 * choices to the end.
 *
 * @packageDocumentation
 */

import { Array, Option, Order, pipe } from 'effect'

import * as Destination from './destination.ts'
import * as LinkChoice from './link-choice.ts'
import * as Provisional from './provisional.ts'
import * as Referent from './referent.ts'

/** What `New` comes to for `referent`: its own resource, a provisional one for its identity, else nothing. */
const newFor = (referent: Referent.Type): Destination.Type =>
  Referent.match(referent, {
    AsResource: (withResource) => Destination.OnOwnResource({ referent: withResource }),
    ByMentionOnly: ({ identity }) =>
      Option.match(Provisional.forIdentity(identity), {
        onNone: () => Destination.Unlinked(),
        onSome: (resource) => Destination.OnProvisionalResource({ resource }),
      }),
  })

/** A choice the referent's kind does not allow reads as its default: own resource, or nothing. */
const defaultFor = (referent: Referent.Type): Destination.Type =>
  Referent.match(referent, {
    AsResource: (withResource) => Destination.OnOwnResource({ referent: withResource }),
    ByMentionOnly: () => Destination.Unlinked(),
  })

const sameType = (referent: Referent.Type, resource: { readonly resourceType: string }): boolean =>
  resource.resourceType === referent.identity.resourceType

/**
 * Where a `SameAs` cycle comes to, whichever member the walk entered at: `New`
 * for the first member, in key order, that `New` places on a resource, else
 * unlinked. One destination for the whole cycle, since the reviewer said its
 * members are one.
 */
const destinationOfCycle = (cycle: readonly Referent.Type[]): Destination.Type =>
  pipe(
    Array.sort(cycle, Order.mapInput(Order.string, Referent.key)),
    Array.map(newFor),
    Array.findFirst((destination) => !Destination.is('Unlinked')(destination)),
    Option.getOrElse(() => Destination.Unlinked())
  )

/**
 * The destination `current`'s choice comes to, `path` being the referents
 * walked to reach it, `current` last.
 */
const resolveFrom = (
  choices: LinkChoice.ByReferent,
  referents: ReadonlyMap<string, Referent.Type>,
  path: readonly Referent.Type[],
  current: Referent.Type
): Destination.Type =>
  LinkChoice.match(LinkChoice.forReferent(choices, current), {
    New: () => newFor(current),
    DontLink: () => defaultFor(current),
    ToStored: ({ resource }) =>
      sameType(current, resource)
        ? Destination.OnStoredResource({ resource })
        : defaultFor(current),
    SameAs: ({ referentKey }) =>
      Referent.match(current, {
        AsResource: () => defaultFor(current),
        ByMentionOnly: (byMentionOnly) =>
          followSameAs(choices, referents, path, byMentionOnly, referentKey),
      }),
  })

/**
 * Where `current`'s `SameAs` the referent keyed `sameAsKey` comes to: that
 * referent's destination, or the cycle's when the walk has been there.
 */
const followSameAs = (
  choices: LinkChoice.ByReferent,
  referents: ReadonlyMap<string, Referent.Type>,
  path: readonly Referent.Type[],
  current: Referent.ByMentionOnly,
  sameAsKey: string
): Destination.Type => {
  const sameAs = referents.get(sameAsKey)
  // A referent of another type is an impossible link: a `subject` never lands on a Practitioner.
  if (sameAs === undefined || !sameType(current, sameAs.identity)) return Destination.Unlinked()
  const cycleStart = path.findIndex((walked) => Referent.key(walked) === sameAsKey)
  return cycleStart === -1
    ? resolveFrom(choices, referents, [...path, sameAs], sameAs)
    : destinationOfCycle(path.slice(cycleStart))
}

/**
 * The destination `referent` comes to under `choices`, given every referent of
 * the file keyed by `Referent.key`.
 *
 * @remarks
 * A choice the referent's kind does not allow reads as its default: a referent
 * with a resource choosing `SameAs`, `DontLink` or a stored resource of
 * another type is on its own resource; one named only by mentions choosing a
 * stored resource of another type, a referent of another type, or one the
 * file does not hold is unlinked. `New` on a referent named only by mentions is
 * provisional when its identity allows it and unlinked otherwise. A `SameAs`
 * cycle resolves to `New` for the first of its members, in key order, that
 * `New` places on a resource, whichever member is resolved, so every referent
 * in it lands on the same one record.
 */
const destinationOf = (
  choices: LinkChoice.ByReferent,
  referents: ReadonlyMap<string, Referent.Type>,
  referent: Referent.Type
): Destination.Type => resolveFrom(choices, referents, [referent], referent)

export { destinationOf }
