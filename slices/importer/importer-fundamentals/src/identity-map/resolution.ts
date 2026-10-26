/**
 * Resolving a referent's choice into its link target, following
 * `LinkToDecodedReferent` choices to the end.
 *
 * @packageDocumentation
 */

import { Array, HashMap, Option, Order, pipe } from 'effect'

import * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

/** What `CreateResource` comes to for `referent`: its decoded resource, a provisional one for its logical reference, else nothing. */
const linkTargetOfCreate = (referent: Referent.Type): LinkTarget.Type =>
  Referent.match(referent, {
    AsResource: ({ resource }) => LinkTarget.Decoded({ resource }),
    ByMentionOnly: ({ logicalReference }) =>
      Option.match(LinkableResource.tryProvisionalFrom(logicalReference), {
        onNone: () => LinkTarget.Unlinked(),
        onSome: (resource) => LinkTarget.Provisional({ resource }),
      }),
  })

/**
 * Where `referent` comes to with no choice that its kind allows: its decoded
 * resource, or nothing. What `LinkChoice.defaultFor` resolves to, and what a
 * choice the kind does not allow reads as.
 */
const linkTargetWithoutChoice = (referent: Referent.Type): LinkTarget.Type =>
  Referent.match(referent, {
    AsResource: ({ resource }) => LinkTarget.Decoded({ resource }),
    ByMentionOnly: () => LinkTarget.Unlinked(),
  })

const sameType = (referent: Referent.Type, resource: { readonly resourceType: string }): boolean =>
  resource.resourceType === referent.logicalReference.type

/**
 * Where a `LinkToDecodedReferent` cycle comes to, whichever member the walk
 * entered at: `CreateResource` for the first member, in key order, that it
 * places on a resource, else unlinked. One target for the whole cycle, since
 * the reviewer said its members are one.
 */
const linkTargetOfCycle = (cycle: readonly Referent.Type[]): LinkTarget.Type =>
  pipe(
    Array.sort(cycle, Order.mapInput(Order.string, Referent.key)),
    Array.map(linkTargetOfCreate),
    Array.findFirst((linkTarget) => !LinkTarget.is('Unlinked')(linkTarget)),
    Option.getOrElse(() => LinkTarget.Unlinked())
  )

/**
 * The link target `current`'s choice comes to, `path` being the referents
 * walked to reach it, `current` last.
 */
const resolveFrom = (
  linkChoices: ReferentLinkChoices.Type,
  referents: HashMap.HashMap<string, Referent.Type>,
  path: readonly Referent.Type[],
  current: Referent.Type
): LinkTarget.Type =>
  LinkChoice.match(LinkChoice.forReferent(linkChoices, current), {
    CreateResource: () => linkTargetOfCreate(current),
    DontLink: () => linkTargetWithoutChoice(current),
    LinkToStoredResource: ({ resource }) =>
      sameType(current, resource)
        ? LinkTarget.Stored({ resource })
        : linkTargetWithoutChoice(current),
    LinkToDecodedReferent: ({ referentKey }) =>
      Referent.match(current, {
        AsResource: () => linkTargetWithoutChoice(current),
        ByMentionOnly: (byMentionOnly) =>
          followLinkToDecodedReferent(linkChoices, referents, path, byMentionOnly, referentKey),
      }),
  })

/**
 * Where `current`'s link to the referent keyed `linkedKey` comes to: that
 * referent's link target, or the cycle's when the walk has been there.
 */
const followLinkToDecodedReferent = (
  linkChoices: ReferentLinkChoices.Type,
  referents: HashMap.HashMap<string, Referent.Type>,
  path: readonly Referent.Type[],
  current: Referent.ByMentionOnly,
  linkedKey: string
): LinkTarget.Type =>
  pipe(
    HashMap.get(referents, linkedKey),
    // A referent of another type is an impossible link: a `subject` never lands on a Practitioner.
    Option.filter((linked) => sameType(current, { resourceType: linked.logicalReference.type })),
    Option.match({
      onNone: () => LinkTarget.Unlinked(),
      onSome: (linked) => {
        const cycleStart = path.findIndex((walked) => Referent.key(walked) === linkedKey)
        return cycleStart === -1
          ? resolveFrom(linkChoices, referents, [...path, linked], linked)
          : linkTargetOfCycle(path.slice(cycleStart))
      },
    })
  )

/**
 * The link target `referent` comes to under `linkChoices`, given every
 * referent of the file keyed by `Referent.key`.
 *
 * @remarks
 * A choice the referent's kind does not allow reads as its default: a referent
 * with a resource choosing `LinkToDecodedReferent`, `DontLink` or a stored
 * resource of another type is on its decoded resource; one named only by
 * mentions choosing a stored resource of another type, a referent of another
 * type, or one the file does not hold is unlinked. `CreateResource` on a
 * referent named only by mentions is provisional when its logical reference
 * allows it and unlinked otherwise.
 * A `LinkToDecodedReferent` cycle resolves to `CreateResource` for the first
 * of its members, in key order, that it places on a resource, whichever
 * member is resolved, so every referent in it lands on the same one resource.
 */
const linkTargetOf = (
  linkChoices: ReferentLinkChoices.Type,
  referents: HashMap.HashMap<string, Referent.Type>,
  referent: Referent.Type
): LinkTarget.Type => resolveFrom(linkChoices, referents, [referent], referent)

export { linkTargetOf }
