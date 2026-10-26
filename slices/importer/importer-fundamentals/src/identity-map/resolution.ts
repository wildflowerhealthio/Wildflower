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
  referent._tag === 'WithResource'
    ? Destination.OnOwnResource({ referent })
    : Option.match(Provisional.forIdentity(referent.identity), {
        onNone: () => Destination.Unlinked(),
        onSome: (resource) => Destination.OnProvisionalResource({ resource }),
      })

/** A choice the referent's kind does not allow reads as its default: own resource, or nothing. */
const defaultFor = (referent: Referent.Type): Destination.Type =>
  referent._tag === 'WithResource'
    ? Destination.OnOwnResource({ referent })
    : Destination.Unlinked()

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

/** `current`'s destination, `path` being the referents walked to reach it, `current` last. */
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
    SameAs: ({ referentKey }) => {
      if (current._tag === 'WithResource') return defaultFor(current)
      const next = referents.get(referentKey)
      // A referent of another type is an impossible link: a `subject` never lands on a Practitioner.
      if (next === undefined || !sameType(current, next.identity)) return Destination.Unlinked()
      const cycleStart = path.findIndex((walked) => Referent.key(walked) === referentKey)
      if (cycleStart === -1) return resolveFrom(choices, referents, [...path, next], next)
      return destinationOfCycle(path.slice(cycleStart))
    },
  })

/**
 * The destination `referent` comes to under `choices`, given every referent of
 * the file keyed by `Referent.key`.
 *
 * @remarks
 * A choice the referent's kind does not allow reads as its default: a referent
 * with a resource choosing `SameAs`, `DontLink` or a stored resource of
 * another type is on its own resource; one only mentions name choosing a
 * stored resource of another type, a referent of another type, or one the
 * file does not hold is unlinked. `New` on a referent only mentions name is
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
