/**
 * A link: a referent with the link target its choice gives, what the plan is
 * built from, made from the reviewer's choices in two phases: the target a
 * choice gives its own referent ({@link localLinkTargetOf}), then, for a
 * `LinkToDecodedReferent`, the chain of choices it starts, followed to one
 * ({@link linkTargetAlong}).
 *
 * @packageDocumentation
 */

import { Array, Either, HashMap, Match, Option, Order, pipe } from 'effect'

import * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'

/** One referent and the resource it is linked to, or none. */
interface Type {
  readonly referent: Referent.Type
  readonly target: LinkTarget.Type
}

/** A referent's link target, or why its choice cannot be followed. */
type LinkTargetOrInvalid = Either.Either<LinkTarget.Type, LinkChoice.InvalidLinkChoice>

/**
 * What a choice gives its own referent: a link target, or why it cannot be
 * followed; for a `LinkToDecodedReferent`, the choice itself, since its
 * target is the linked referent's and not local.
 */
type LocalLinkTarget = Either.Either<
  LinkTarget.Type | LinkChoice.LinkToDecodedReferentType,
  LinkChoice.InvalidLinkChoice
>

/**
 * A choice with the referent it is made for, tagged by both their tags
 * (`CreateResource:AsResource`): one case per cell of the choice-by-kind
 * table, so a match over it is exhaustive over the table.
 */
type ChoiceForReferent = {
  readonly [C in LinkChoice.Type['_tag']]: {
    readonly [R in Referent.Type['_tag']]: {
      readonly _tag: `${C}:${R}`
      readonly choice: Extract<LinkChoice.Type, { readonly _tag: C }>
      readonly referent: Extract<Referent.Type, { readonly _tag: R }>
    }
  }[Referent.Type['_tag']]
}[LinkChoice.Type['_tag']]

/** The cells tagged `TTag`. */
type Cell<TTag extends ChoiceForReferent['_tag']> = Extract<
  ChoiceForReferent,
  { readonly _tag: TTag }
>

/** `choice` for `referent` as its cell. */
const choiceForReferent = (choice: LinkChoice.Type, referent: Referent.Type): ChoiceForReferent =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tag is built from the tags of the two fields it is paired with, so the value is the cell it names; TypeScript cannot correlate a template literal with the fields it was built from.
  ({ _tag: `${choice._tag}:${referent._tag}`, choice, referent }) as ChoiceForReferent

/** Whether a local link target is a target, rather than a `LinkToDecodedReferent` to follow. */
const isLinkTarget = (
  local: LinkTarget.Type | LinkChoice.LinkToDecodedReferentType
): local is LinkTarget.Type => !LinkChoice.is('LinkToDecodedReferent')(local)

/** `choice` as the failure it is for `referent`, for `reason`. */
const invalid = (
  referent: Referent.Type,
  choice: LinkChoice.Type,
  reason: LinkChoice.InvalidLinkChoiceReason
): LinkChoice.InvalidLinkChoice =>
  new LinkChoice.InvalidLinkChoice({ referentKey: Referent.key(referent), choice, reason })

/** `CreateResource` with a resource: the decoded resource, written as it is. */
const decodedTarget = ({ referent }: Cell<'CreateResource:AsResource'>): LocalLinkTarget =>
  Either.right(LinkTarget.Decoded({ resource: referent.resource, storedCopy: Option.none() }))

/**
 * `CreateResource` named only by mentions: the referent's own record, the
 * provisional resource its logical reference stands for, when there is one.
 */
const provisionalTarget = ({
  choice,
  referent,
}: Cell<'CreateResource:ByMentionOnly'>): LocalLinkTarget =>
  Either.fromOption(
    Option.map(Referent.maybeOwnResource(referent), (resource) =>
      LinkTarget.Provisional({ resource })
    ),
    () => invalid(referent, choice, 'NotAllowedForReferent')
  )

/**
 * `UpdateStoredResource` with a resource: the decoded resource over its
 * stored copy, when the copy is the same record.
 */
const decodedOverStoredCopyTarget = ({
  choice,
  referent,
}: Cell<'UpdateStoredResource:AsResource'>): LocalLinkTarget =>
  LinkableResource.sameRecord(referent.resource, choice.resource)
    ? Either.right(
        LinkTarget.Decoded({
          resource: referent.resource,
          storedCopy: Option.some(choice.resource),
        })
      )
    : Either.left(invalid(referent, choice, 'StoredResourceUnderAnotherId'))

/** `LinkToStoredResource`: the stored resource, when it is of the referent's type. */
const storedTarget = ({
  choice,
  referent,
}: Cell<
  'LinkToStoredResource:AsResource' | 'LinkToStoredResource:ByMentionOnly'
>): LocalLinkTarget =>
  choice.resource.resourceType === referent.logicalReference.type
    ? Either.right(LinkTarget.Stored({ resource: choice.resource }))
    : Either.left(invalid(referent, choice, 'StoredResourceOfAnotherType'))

/** `LinkToDecodedReferent` named only by mentions: not local, the link to follow. */
const linkedReferentToFollow = ({
  choice,
}: Cell<'LinkToDecodedReferent:ByMentionOnly'>): LocalLinkTarget => Either.right(choice)

/** `DontLink` named only by mentions: no resource. */
const unlinkedTarget = (): LocalLinkTarget => Either.right(LinkTarget.Unlinked())

/** A choice the referent's kind does not allow. */
const notAllowed = ({ choice, referent }: ChoiceForReferent): LocalLinkTarget =>
  Either.left(invalid(referent, choice, 'NotAllowedForReferent'))

/**
 * The link target a choice gives its own referent: one cell per choice and
 * referent kind, the cells a kind does not allow last. A
 * `LinkToDecodedReferent` for a referent named only by mentions is the one
 * cell that is not local.
 */
const localLinkTargetOf: (cell: ChoiceForReferent) => LocalLinkTarget = Match.typeTags<
  ChoiceForReferent,
  LocalLinkTarget
>()({
  'CreateResource:AsResource': decodedTarget,
  'CreateResource:ByMentionOnly': provisionalTarget,
  'UpdateStoredResource:AsResource': decodedOverStoredCopyTarget,
  'LinkToStoredResource:AsResource': storedTarget,
  'LinkToStoredResource:ByMentionOnly': storedTarget,
  'LinkToDecodedReferent:ByMentionOnly': linkedReferentToFollow,
  'DontLink:ByMentionOnly': unlinkedTarget,
  'UpdateStoredResource:ByMentionOnly': notAllowed,
  'LinkToDecodedReferent:AsResource': notAllowed,
  'DontLink:AsResource': notAllowed,
})

/**
 * Where a `LinkToDecodedReferent` cycle comes to, whichever member the chain
 * entered at: `CreateResource` for the first member, in key order, that it
 * links to a resource, else unlinked. One target for the whole cycle, since
 * the reviewer said its members are one.
 */
const linkTargetOfCycle = (cycle: readonly Referent.Type[]): LinkTarget.Type =>
  pipe(
    Array.sort(cycle, Order.mapInput(Order.string, Referent.key)),
    Array.findFirst((member) =>
      pipe(
        localLinkTargetOf(choiceForReferent(LinkChoice.CreateResource(), member)),
        Either.getRight,
        Option.filter(isLinkTarget)
      )
    ),
    Option.getOrElse(() => LinkTarget.Unlinked())
  )

/**
 * The link target the last referent of `path` comes to: its choice's local
 * target, or, for a `LinkToDecodedReferent`, the linked referent's, with
 * `path` the referents the chain passed through on the way.
 *
 * @remarks
 * Each hop ends the chain or takes one more step: a linked referent the
 * batch does not hold, or one of another type, fails with the choice that
 * named it; one already on `path` closes a cycle, from its first occurrence
 * on, which {@link linkTargetOfCycle} links; any other is the next referent of
 * the chain, whose local target, a failure included, ends it.
 */
const linkTargetAlong = (
  referentsByKey: HashMap.HashMap<string, Referent.Type>,
  byReferent: ReferentLinkChoiceSet.Type,
  path: Array.NonEmptyReadonlyArray<Referent.Type>
): LinkTargetOrInvalid => {
  const current = Array.lastNonEmpty(path)
  return Either.flatMap(
    localLinkTargetOf(
      choiceForReferent(ReferentLinkChoiceSet.forReferent(byReferent, current), current)
    ),
    (local) =>
      isLinkTarget(local)
        ? Either.right(local)
        : pipe(
            HashMap.get(referentsByKey, local.referentKey),
            Either.fromOption(() => invalid(current, local, 'LinkedReferentNotInBatch')),
            Either.filterOrLeft(
              (linked) => linked.logicalReference.type === current.logicalReference.type,
              () => invalid(current, local, 'LinkedReferentOfAnotherType')
            ),
            Either.flatMap((linked) =>
              Option.match(
                Array.findFirstIndex(path, (onPath) => Referent.key(onPath) === local.referentKey),
                {
                  onSome: (cycleStart) => Either.right(linkTargetOfCycle(path.slice(cycleStart))),
                  onNone: () =>
                    linkTargetAlong(referentsByKey, byReferent, Array.append(path, linked)),
                }
              )
            )
          )
  )
}

/**
 * Every referent of `referents` linked to the target its choice under
 * `byReferent` gives, in the order given; the first choice that cannot be
 * followed, as the failure it is, otherwise.
 *
 * @remarks
 * Two phases. A choice's local target for its own referent
 * ({@link localLinkTargetOf}) is one cell of the choice-by-kind table: it
 * fails with `LinkChoice.InvalidLinkChoice` when the referent's kind does not
 * allow it (`DontLink` or `LinkToDecodedReferent` with a resource,
 * `CreateResource` named only by mentions with no provisional form,
 * `UpdateStoredResource` named only by mentions), when it names a stored
 * resource of another type, or a stored resource to update under another id
 * than the referent's own. A `LinkToDecodedReferent` is not local: its chain
 * is followed ({@link linkTargetAlong}), failing when it names a referent of
 * another type or one `referents` does not hold, and ending on the first
 * local target it reaches, so a choice that leads to a failure fails with
 * it, named for the referent whose choice it is. A cycle is linked as
 * `CreateResource` for the first of its members, in key order, that it links
 * to a resource, whichever member the chain entered at, so every referent in
 * it is redirected to the same one resource. Each referent's chain is followed on
 * its own; none is longer than `referents`.
 */
const fromChoices = (
  referents: readonly Referent.Type[],
  byReferent: ReferentLinkChoiceSet.Type
): Either.Either<readonly Type[], LinkChoice.InvalidLinkChoice> => {
  const referentsByKey = Referent.byKey(referents)
  return Either.all(
    referents.map((referent) =>
      Either.map(linkTargetAlong(referentsByKey, byReferent, [referent]), (target): Type => ({
        referent,
        target,
      }))
    )
  )
}

export { fromChoices }
export type { Type }
