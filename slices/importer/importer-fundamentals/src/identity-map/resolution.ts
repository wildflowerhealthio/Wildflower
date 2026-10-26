/**
 * Resolving a referent's choice into its destination, following `SameAs`
 * choices to the end.
 *
 * @packageDocumentation
 */

import { Option } from 'effect'

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

const resolveFrom = (
  choices: LinkChoice.ByReferent,
  referents: ReadonlyMap<string, Referent.Type>,
  start: Referent.Type,
  current: Referent.Type,
  visited: ReadonlySet<string>
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
      if (next === undefined || !sameType(current, { resourceType: next.identity.resourceType })) {
        return Destination.Unlinked()
      }
      return visited.has(referentKey)
        ? newFor(start)
        : resolveFrom(choices, referents, start, next, new Set([...visited, referentKey]))
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
 * cycle resolves to `New` for the referent resolved, so only one referent in
 * it becomes provisional.
 */
const destinationOf = (
  choices: LinkChoice.ByReferent,
  referents: ReadonlyMap<string, Referent.Type>,
  referent: Referent.Type
): Destination.Type =>
  resolveFrom(choices, referents, referent, referent, new Set([Referent.key(referent)]))

export { destinationOf }
