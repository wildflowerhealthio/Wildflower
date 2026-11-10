/**
 * A link: a referent with the link target its choice gives, what the plan is
 * built from.
 *
 * @packageDocumentation
 */

import { Either, Match, Option } from 'effect'

import * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'

/** One referent and the resource it is linked to. */
interface Type {
  readonly referent: Referent.Type
  readonly target: LinkTarget.Linked
}

/** `choice` as the failure it is for `referent`, for `reason`. */
const invalid = (
  referent: Referent.Type,
  choice: LinkChoice.Type,
  reason: LinkChoice.InvalidLinkChoiceReason
): LinkChoice.InvalidLinkChoice =>
  new LinkChoice.InvalidLinkChoice({ referentKey: Referent.key(referent), choice, reason })

/**
 * The link target `choice` gives `referent`: its decoded resource for
 * `CreateResource`; its decoded resource over the stored copy for
 * `UpdateStoredResource`, when the copy is the same record; the stored
 * resource for `LinkToStoredResource`, when it is of the referent's type.
 */
const linkTargetOf = (
  referent: Referent.Type,
  choice: LinkChoice.Type
): Either.Either<LinkTarget.Linked, LinkChoice.InvalidLinkChoice> =>
  Match.value(choice).pipe(
    Match.tag(
      'CreateResource',
      (): Either.Either<LinkTarget.Linked, LinkChoice.InvalidLinkChoice> =>
        Either.right(LinkTarget.Decoded({ resource: referent.resource, storedCopy: Option.none() }))
    ),
    Match.tag('UpdateStoredResource', (update) =>
      LinkableResource.sameRecord(referent.resource, update.resource)
        ? Either.right(
            LinkTarget.Decoded({
              resource: referent.resource,
              storedCopy: Option.some(update.resource),
            })
          )
        : Either.left(invalid(referent, update, 'StoredResourceUnderAnotherId'))
    ),
    Match.tag('LinkToStoredResource', (link) =>
      link.resource.resourceType === referent.logicalReference.resourceType
        ? Either.right(LinkTarget.Stored({ resource: link.resource }))
        : Either.left(invalid(referent, link, 'StoredResourceOfAnotherType'))
    ),
    Match.exhaustive
  )

/**
 * Every referent of `referents` linked to the target its choice under
 * `byReferent` gives ({@link linkTargetOf}), in the order given; the first
 * choice that cannot be followed, as the failure it is, otherwise.
 */
const fromChoices = (
  referents: readonly Referent.Type[],
  byReferent: ReferentLinkChoiceSet.Type
): Either.Either<readonly Type[], LinkChoice.InvalidLinkChoice> =>
  Either.all(
    referents.map((referent) =>
      Either.map(
        linkTargetOf(referent, ReferentLinkChoiceSet.forReferent(byReferent, referent)),
        (target): Type => ({ referent, target })
      )
    )
  )

export { fromChoices }
export type { Type }
