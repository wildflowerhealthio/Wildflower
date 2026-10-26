/**
 * Resolving every referent's choice into its link target, following
 * `LinkToDecodedReferent` choices to the end.
 *
 * @packageDocumentation
 */

import { Array, Either, HashMap, Option, Order, pipe } from 'effect'

import * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import type * as Link from './link.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

type Resolved = Either.Either<LinkTarget.Type, LinkChoice.InvalidLinkChoice>

/** What `CreateResource` places `referent` on: its decoded resource, a provisional one for its logical reference, else nothing. */
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

/** `choice` as the failure it is for `referent`, for `reason`. */
const invalid = (
  referent: Referent.Type,
  choice: LinkChoice.Type,
  reason: LinkChoice.InvalidLinkChoiceReason
): Resolved =>
  Either.left(
    new LinkChoice.InvalidLinkChoice({ referentKey: Referent.key(referent), choice, reason })
  )

const sameType = (referent: Referent.Type, resource: { readonly resourceType: string }): boolean =>
  resource.resourceType === referent.logicalReference.type

/**
 * Every referent of `referents` with the link target its choice under
 * `linkChoices` resolves to, in the order given; the first choice that cannot
 * be followed, as the failure it is, otherwise.
 *
 * @remarks
 * A choice fails with `LinkChoice.InvalidLinkChoice` when the referent's kind
 * does not allow it (`DontLink` or `LinkToDecodedReferent` with a resource,
 * `CreateResource` named only by mentions with no provisional form), when it
 * names a stored resource or a referent of another type, or a referent
 * `referents` does not hold; a choice that leads to one fails with it.
 * A `LinkToDecodedReferent` cycle resolves to `CreateResource` for the first
 * of its members, in key order, that it places on a resource, whichever
 * member is resolved, so every referent in it lands on the same one resource.
 * Each referent is resolved once: a walk that reaches one already resolved
 * takes its target, which is the same whichever walk reaches it.
 */
const linksOf = (
  linkChoices: ReferentLinkChoices.Type,
  referents: readonly Referent.Type[]
): Either.Either<readonly Link.Type[], LinkChoice.InvalidLinkChoice> => {
  const referentsByKey = Referent.byKey(referents)
  const resolvedByKey = new Map<string, Resolved>()
  // The referents of the walk in progress, in order, and each one's place on it.
  const walk: Referent.Type[] = []
  const placeOnWalkByKey = new Map<string, number>()

  const followLinkToDecodedReferent = (
    current: Referent.ByMentionOnly,
    link: LinkChoice.LinkToDecodedReferentType
  ): Resolved =>
    Option.match(HashMap.get(referentsByKey, link.referentKey), {
      onNone: () => invalid(current, link, 'LinkedReferentNotInFile'),
      onSome: (linked) => {
        if (!sameType(current, { resourceType: linked.logicalReference.type })) {
          return invalid(current, link, 'LinkedReferentOfAnotherType')
        }
        const cycleStart = placeOnWalkByKey.get(link.referentKey)
        return cycleStart === undefined
          ? resolve(linked)
          : Either.right(linkTargetOfCycle(walk.slice(cycleStart)))
      },
    })

  const resolveChoice = (current: Referent.Type): Resolved => {
    const choice = LinkChoice.forReferent(linkChoices, current)
    return LinkChoice.match(choice, {
      CreateResource: () => {
        const created = linkTargetOfCreate(current)
        return LinkTarget.is('Unlinked')(created)
          ? invalid(current, choice, 'NotAllowedForReferent')
          : Either.right(created)
      },
      DontLink: () =>
        Referent.match(current, {
          AsResource: () => invalid(current, choice, 'NotAllowedForReferent'),
          ByMentionOnly: () => Either.right(LinkTarget.Unlinked()),
        }),
      LinkToStoredResource: ({ resource }) =>
        sameType(current, resource)
          ? Either.right(LinkTarget.Stored({ resource }))
          : invalid(current, choice, 'StoredResourceOfAnotherType'),
      LinkToDecodedReferent: (link) =>
        Referent.match(current, {
          AsResource: () => invalid(current, choice, 'NotAllowedForReferent'),
          ByMentionOnly: (byMentionOnly) => followLinkToDecodedReferent(byMentionOnly, link),
        }),
    })
  }

  const resolve = (current: Referent.Type): Resolved => {
    const currentKey = Referent.key(current)
    const alreadyResolved = resolvedByKey.get(currentKey)
    if (alreadyResolved !== undefined) return alreadyResolved
    placeOnWalkByKey.set(currentKey, walk.length)
    walk.push(current)
    const resolved = resolveChoice(current)
    walk.pop()
    placeOnWalkByKey.delete(currentKey)
    resolvedByKey.set(currentKey, resolved)
    return resolved
  }

  return Either.all(
    referents.map((referent) =>
      Either.map(resolve(referent), (target): Link.Type => ({ referent, target }))
    )
  )
}

export { linksOf }
