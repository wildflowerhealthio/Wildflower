/**
 * A link: a referent with the link target its choice gives, what the plan is
 * built from, made from the reviewer's choices by following
 * `LinkToDecodedReferent` choices to the end; and a linked resource, a link
 * that landed on one.
 *
 * @packageDocumentation
 */

import { Array, Either, HashMap, Option, Order, pipe } from 'effect'

import * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

/** One referent and the resource it is linked to, or none. */
interface Type {
  readonly referent: Referent.Type
  readonly target: LinkTarget.Type
}

/** A link that landed on a resource: the referent, and its target, which holds one. */
interface LinkedResource {
  readonly referent: Referent.Type
  readonly target: Exclude<LinkTarget.Type, LinkTarget.UnlinkedType>
}

/** `link` as a linked resource; `None` when its target is `Unlinked`. */
const tryIntoLinkedResource = ({ referent, target }: Type): Option.Option<LinkedResource> =>
  LinkTarget.is('Unlinked')(target) ? Option.none() : Option.some({ referent, target })

/** A referent's link target, or why its choice cannot be followed. */
type LinkTargetOrInvalid = Either.Either<LinkTarget.Type, LinkChoice.InvalidLinkChoice>

/** What `CreateResource` links `referent` to: its decoded resource, a provisional one for its logical reference, else nothing. */
const linkTargetOfCreate = (referent: Referent.Type): LinkTarget.Type =>
  Referent.match(referent, {
    AsResource: ({ resource }) => LinkTarget.Decoded({ resource, storedCopy: Option.none() }),
    ByMentionOnly: ({ logicalReference }) =>
      Option.match(LinkableResource.tryProvisionalFrom(logicalReference), {
        onNone: () => LinkTarget.Unlinked(),
        onSome: (resource) => LinkTarget.Provisional({ resource }),
      }),
  })

/**
 * Where a `LinkToDecodedReferent` cycle comes to, whichever member the walk
 * entered at: `CreateResource` for the first member, in key order, that it
 * links to a resource, else unlinked. One target for the whole cycle, since
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
): LinkTargetOrInvalid =>
  Either.left(
    new LinkChoice.InvalidLinkChoice({ referentKey: Referent.key(referent), choice, reason })
  )

const sameType = (referent: Referent.Type, resource: { readonly resourceType: string }): boolean =>
  resource.resourceType === referent.logicalReference.type

/**
 * Every referent of `referents` linked to the target its choice under
 * `linkChoices` gives, in the order given; the first choice that cannot be
 * followed, as the failure it is, otherwise.
 *
 * @remarks
 * A choice fails with `LinkChoice.InvalidLinkChoice` when the referent's kind
 * does not allow it (`DontLink` or `LinkToDecodedReferent` with a resource,
 * `CreateResource` named only by mentions with no provisional form,
 * `UpdateStoredResource` named only by mentions), when it names a stored
 * resource or a referent of another type, a stored resource to update under
 * another id than the referent's own, or a referent `referents` does not
 * hold; a choice that leads to one fails with it.
 * A `LinkToDecodedReferent` cycle is linked as `CreateResource` for the first
 * of its members, in key order, that it links to a resource, whichever
 * member the walk entered at, so every referent in it lands on the same one
 * resource. Each referent's target is worked out once: a walk that reaches
 * one already linked takes its target, which is the same whichever walk
 * reaches it.
 */
const fromChoices = (
  referents: readonly Referent.Type[],
  linkChoices: ReferentLinkChoices.Type
): Either.Either<readonly Type[], LinkChoice.InvalidLinkChoice> => {
  const referentsByKey = Referent.byKey(referents)
  const linkTargetsByKey = new Map<string, LinkTargetOrInvalid>()
  // The referents of the walk in progress, in order, and each one's position on it.
  const walk: Referent.Type[] = []
  const positionOnWalkByKey = new Map<string, number>()

  const followLinkToDecodedReferent = (
    current: Referent.ByMentionOnly,
    link: LinkChoice.LinkToDecodedReferentType
  ): LinkTargetOrInvalid =>
    Option.match(HashMap.get(referentsByKey, link.referentKey), {
      onNone: () => invalid(current, link, 'LinkedReferentNotInBatch'),
      onSome: (linked) => {
        if (!sameType(current, { resourceType: linked.logicalReference.type })) {
          return invalid(current, link, 'LinkedReferentOfAnotherType')
        }
        const cycleStart = positionOnWalkByKey.get(link.referentKey)
        return cycleStart === undefined
          ? linkTargetOf(linked)
          : Either.right(linkTargetOfCycle(walk.slice(cycleStart)))
      },
    })

  const linkTargetOfChoice = (current: Referent.Type): LinkTargetOrInvalid => {
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
      UpdateStoredResource: ({ resource: storedCopy }) =>
        Referent.match(current, {
          AsResource: ({ resource: decoded }) =>
            LinkableResource.literalReferenceOf(decoded) ===
            LinkableResource.literalReferenceOf(storedCopy)
              ? Either.right(
                  LinkTarget.Decoded({ resource: decoded, storedCopy: Option.some(storedCopy) })
                )
              : invalid(current, choice, 'StoredResourceUnderAnotherId'),
          ByMentionOnly: () => invalid(current, choice, 'NotAllowedForReferent'),
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

  const linkTargetOf = (current: Referent.Type): LinkTargetOrInvalid => {
    const currentKey = Referent.key(current)
    const known = linkTargetsByKey.get(currentKey)
    if (known !== undefined) return known
    positionOnWalkByKey.set(currentKey, walk.length)
    walk.push(current)
    const linkTarget = linkTargetOfChoice(current)
    walk.pop()
    positionOnWalkByKey.delete(currentKey)
    linkTargetsByKey.set(currentKey, linkTarget)
    return linkTarget
  }

  return Either.all(
    referents.map((referent) =>
      Either.map(linkTargetOf(referent), (target): Type => ({ referent, target }))
    )
  )
}

export { fromChoices, tryIntoLinkedResource }
export type { LinkedResource, Type }
