/**
 * The options a mention's select offers: each resource a referent of the
 * batch lands on, of the type the mention names, labelled, and the mention
 * link choice picking it makes.
 *
 * @remarks
 * A pick onto a stored resource is `LinkToStoredResource`, which no
 * referent's later choice moves; one onto a referent's own decoded or
 * provisional record is `LinkToDecodedReferent` of that referent, so the
 * mention follows the referent when it is later linked to a stored one.
 * Several referents may land on one record; picking it is the choice of the
 * referent whose record it is, so the mention follows that one rather than a
 * referent merely linked to it.
 *
 * @packageDocumentation
 */

import {
  LinkableLogicalReference,
  LinkableResource,
  LinkChoice,
  LinkTarget,
  type MentionLinkChoices,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Effect, HashMap, Option, pipe } from 'effect'

import * as LinkChoiceOptions from './link-choice-options.ts'

/** One resource a mention may be landed on: its option value, its label, and the choice picking it makes. */
interface Offer {
  /** Unique among one select's options: `LinkChoiceOptions.valueOf` the choice. */
  readonly value: string
  readonly label: string
  readonly literalReference: string
  readonly choice: MentionLinkChoices.Choice
}

/** What the mention selects offer: the resources a mention can land on, by type, and each one's label. */
interface Type {
  readonly offersByType: HashMap.HashMap<LinkableLogicalReference.ResourceType, readonly Offer[]>
  /** Each offered resource's label, by its literal reference: how a row names its subject. */
  readonly labelsByLiteralReference: ReadonlyMap<string, string>
}

/** Nothing offered: no referent lands anywhere, so no mention can be picked for. */
const empty: Type = { offersByType: HashMap.empty(), labelsByLiteralReference: new Map() }

/** A resource a referent lands on, the choice picking it makes, and whether that referent's record it is. */
interface Landing {
  readonly resource: LinkableResource.WithId
  readonly choice: MentionLinkChoices.Choice
  readonly isOwnRecord: boolean
}

/** Whether `target`'s resource is `referent`'s own: its decoded resource, or the provisional one its logical reference stands for. */
const isOwnRecordOf = (referent: Referent.Type, resource: LinkableResource.WithId): boolean =>
  Referent.match(referent, {
    AsResource: (asResource) => LinkableResource.sameRecord(asResource.resource, resource),
    ByMentionOnly: ({ logicalReference }) =>
      Option.exists(LinkableResource.tryProvisionalFrom(logicalReference), (provisional) =>
        LinkableResource.sameRecord(provisional, resource)
      ),
  })

/** Where `referent` lands under its `target`, as a landing; `None` for `Unlinked`. */
const landingOf = (referent: Referent.Type, target: LinkTarget.Type): Option.Option<Landing> =>
  LinkTarget.match(target, {
    Stored: ({ resource }) =>
      Option.some({
        resource,
        choice: LinkChoice.LinkToStoredResource({ resource }),
        isOwnRecord: true,
      }),
    Decoded: ({ resource }) =>
      Option.some({
        resource,
        choice: LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(referent) }),
        isOwnRecord: isOwnRecordOf(referent, resource),
      }),
    Provisional: ({ resource }) =>
      Option.some({
        resource,
        choice: LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(referent) }),
        isOwnRecord: isOwnRecordOf(referent, resource),
      }),
    Unlinked: () => Option.none(),
  })

/**
 * The options the batch's referents give the mention selects, under their
 * link targets: each resource a referent lands on, once, labelled
 * (`LinkableResource.labelOf`, which reads the clock for the current name).
 *
 * @param referents - The batch's referents, once per identity
 * @param linkTargetsByReferentKey - Each referent's link target, by `Referent.key`
 */
const fromLinkTargets = (
  referents: readonly Referent.Type[],
  linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>
): Effect.Effect<Type> => {
  const landings = pipe(
    referents,
    Array.filterMap((referent) =>
      Option.flatMap(HashMap.get(linkTargetsByReferentKey, Referent.key(referent)), (target) =>
        landingOf(referent, target)
      )
    ),
    // One offer per record: the referent whose record it is wins over one linked to it.
    Array.groupBy(({ resource }) => LinkableResource.literalReferenceOf(resource)),
    (byLiteralReference) =>
      Object.values(byLiteralReference).map(
        (sharing) => sharing.find(({ isOwnRecord }) => isOwnRecord) ?? sharing[0]
      )
  )
  return Effect.map(
    Effect.forEach(landings, ({ resource, choice }) => {
      const literalReference = LinkableResource.literalReferenceOf(resource)
      return Effect.map(
        LinkableResource.labelOf(resource, literalReference),
        (label): readonly [LinkableLogicalReference.ResourceType, Offer] => [
          resource.resourceType,
          { value: LinkChoiceOptions.valueOf(choice), label, literalReference, choice },
        ]
      )
    }),
    (offers): Type => ({
      offersByType: HashMap.fromIterable(
        LinkableLogicalReference.RESOURCE_TYPES.map(
          (type) =>
            [type, offers.filter(([ofType]) => ofType === type).map(([, offer]) => offer)] as const
        )
      ),
      labelsByLiteralReference: new Map(
        offers.map(([, { literalReference, label }]) => [literalReference, label])
      ),
    })
  )
}

/** The offers for a mention naming `type`. */
const forType = (options: Type, type: LinkableLogicalReference.ResourceType): readonly Offer[] =>
  Option.getOrElse(HashMap.get(options.offersByType, type), () => [])

export { empty, forType, fromLinkTargets }
export type { Offer, Type }
