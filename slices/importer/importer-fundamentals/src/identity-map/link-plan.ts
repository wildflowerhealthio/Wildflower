/**
 * The link plan: the reviewer's choices made into links, worked out once for
 * a batch, and the questions the resolution and the review ask of it.
 *
 * @remarks
 * The reviewer's choices become links, the links are the plan, the plan
 * resolves the batch, and the screen offers what the plan will write. The
 * plan holds:
 *
 * - **links**: each referent with its link target, made from the link
 *   choice set by referent (`Link.fromChoices`), in discovery order, indexed
 *   by referent key and by every logical reference a referent answers to;
 * - **stand-ins**: the stored resource standing in for each decoded resource
 *   a link replaces;
 * - **chosen link targets by mention**: the link target of each mention the
 *   reviewer chose a link for on its own, made from the link choice set by
 *   mention (laid on by {@link withMentionLinkChoiceSet});
 * - **resolved resources**: the resource under each literal reference the
 *   links redirect to, as it will be written, having assumed the identifiers
 *   of every referent linked to it (`ResolvedResource.fromLinks`), in the
 *   order the links first reach it, indexed by that literal reference.
 *
 * Outside this module the plan is read only through its questions:
 * {@link linkTargetIfReferentKey}, {@link linkTargets},
 * {@link redirectionIfLinked}, {@link resolvedResourceIfReferent},
 * {@link linkTargetIfChosenForMention} and {@link resolvedResources}. Built
 * once per batch by {@link make}, so a referent one file holds is the link
 * target of a mention in another.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, HashMap, Match, Option, pipe } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import * as SectionedList from '../sectioned-list.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as Link from './link.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as MentionLinkChoiceSet from './mention-link-choice-set.ts'
import type * as Mention from './mention.ts'
import type * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'
import * as ResolvedResource from './resolved-resource.ts'

/** The link plan for a batch's decoded files, built once by {@link make}. */
interface Type {
  /** Every referent of the batch with its link target, in discovery order. */
  readonly links: readonly Link.Type[]
  /** Each link by its referent's key (`Referent.key`). */
  readonly linksByReferent: HashMap.HashMap<LogicalReference.Key, Link.Type>
  /**
   * The links answering to each logical reference, by its key: every one a
   * referent answers to (`Referent.logicalReferencesOf`), its key among them.
   */
  readonly linksByLogicalReference: HashMap.HashMap<
    LogicalReference.Key,
    Array.NonEmptyReadonlyArray<Link.Type>
  >
  /** The stored resource standing in for each decoded resource a link replaces, by the decoded resource's literal reference. */
  readonly standInByDecodedLiteralReference: HashMap.HashMap<string, LinkableResource.WithId>
  /** The link target chosen for each mention chosen for on its own, by `MentionLinkChoiceSet.key`; none until {@link withMentionLinkChoiceSet}. */
  readonly chosenLinkTargetByMention: HashMap.HashMap<MentionLinkChoiceSet.Key, LinkTarget.Type>
  /** The resource under each literal reference the links redirect to, as it will be written, in the order the links first reach it. */
  readonly resolvedResources: readonly ResolvedResource.Type[]
  /** Each resolved resource by the literal reference it is written under. */
  readonly resolvedByLiteralReference: HashMap.HashMap<string, ResolvedResource.Type>
}

/** `items` by `keyOf`, the first item under each key kept. */
const firstByKey = <K, V>(items: readonly V[], keyOf: (item: V) => K): HashMap.HashMap<K, V> =>
  Array.reduce(items, HashMap.empty<K, V>(), (byKey, item) => {
    const key = keyOf(item)
    return HashMap.has(byKey, key) ? byKey : HashMap.set(byKey, key, item)
  })

/**
 * The stored resource standing in for each decoded resource `links` replace:
 * a referent linked to a stored resource, by the literal reference of the
 * referent's decoded resource. Two referents keyed by different identifiers
 * can hold one decoded resource; the first in discovery order gives its
 * stand-in.
 */
const standInsOf = (
  links: readonly Link.Type[]
): HashMap.HashMap<string, LinkableResource.WithId> =>
  pipe(
    links,
    Array.filterMap(({ referent, target }) =>
      Option.map(
        Option.liftPredicate(target, LinkTarget.is('Stored')),
        ({ resource }) =>
          [LinkableResource.literalReferenceOf(referent.resource), resource] as const
      )
    ),
    (standIns) => firstByKey(standIns, ([decoded]) => decoded),
    HashMap.map(([, resource]) => resource)
  )

/** The links answering to each logical reference, each link once under each of its keys. */
const linksByLogicalReferenceOf = (
  links: readonly Link.Type[]
): HashMap.HashMap<LogicalReference.Key, Array.NonEmptyReadonlyArray<Link.Type>> =>
  Array.reduce(links, HashMap.empty(), (byKey, link) =>
    Array.reduce(
      Array.dedupe(Referent.logicalReferencesOf(link.referent).map(LogicalReference.key)),
      byKey,
      (indexed, key) =>
        HashMap.set(
          indexed,
          key,
          Option.match(HashMap.get(indexed, key), {
            onNone: () => Array.of(link),
            onSome: (answering) => Array.append(answering, link),
          })
        )
    )
  )

/** The plan of a batch with no referent: no links, no mention chosen for, no resolved resources. */
const empty: Type = {
  links: [],
  linksByReferent: HashMap.empty(),
  linksByLogicalReference: HashMap.empty(),
  standInByDecodedLiteralReference: HashMap.empty(),
  chosenLinkTargetByMention: HashMap.empty(),
  resolvedResources: [],
  resolvedByLiteralReference: HashMap.empty(),
}

/**
 * The literal reference the decoded resource under `decodedLiteralReference`
 * is written under: the stored stand-in's, else its own.
 */
const resolvedLiteralReferenceOf = (
  standIns: HashMap.HashMap<string, LinkableResource.WithId>,
  decodedLiteralReference: string
): string =>
  Option.match(HashMap.get(standIns, decodedLiteralReference), {
    onNone: () => decodedLiteralReference,
    onSome: LinkableResource.literalReferenceOf,
  })

/**
 * The literal references of the linkable decoded resources of `decodedFiles`
 * the batch writes where they were decoded: those no stored resource under
 * another id stands in for. A decoded resource a stored one under another id
 * replaces is not written under its own literal reference, so a stored copy
 * under that reference, which a mention may link to, is not written by any
 * resolved file.
 */
const literalReferencesWrittenAsDecoded = (
  links: readonly Link.Type[],
  decodedFiles: readonly DecodedFile.DecodedFile[]
): readonly string[] =>
  pipe(
    decodedFiles.flatMap((file) => SectionedList.rows(file.rows)),
    Array.filterMap(({ resource }) =>
      Option.map(
        Option.liftPredicate(resource, LinkableResource.is),
        LinkableResource.literalReferenceOf
      )
    ),
    Array.filter(
      (decodedLiteralReference) =>
        resolvedLiteralReferenceOf(standIns, decodedLiteralReference) === decodedLiteralReference
    )
  )

/**
 * The plan for a batch's `decodedFiles` on the link choice set by referent,
 * `byReferent`: each referent's choice made once into its link
 * (`Link.fromChoices`), and the resolved resources those links redirect to;
 * no mention link yet ({@link withMentionLinkChoiceSet}).
 *
 * @remarks
 * The referents are the whole batch's (`Referent.discover`), so a referent
 * one file holds is the link target of a mention in another, and every file
 * is resolved on the same plan. Fails with `Referent.DuplicateReferent` when
 * two decoded resources answer to one logical reference, and with
 * `LinkChoice.InvalidLinkChoice` when a choice cannot be followed for its
 * referent.
 */
const make = (
  decodedFiles: readonly DecodedFile.DecodedFile[],
  byReferent: ReferentLinkChoiceSet.Type
): Effect.Effect<Type, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.gen(function* () {
    const referents = yield* Referent.discover(decodedFiles)
    const links = yield* Link.fromChoices(referents, byReferent)
    const standIns = standInsOf(links)
    const resolvedResources = yield* ResolvedResource.fromLinks(
      links,
      literalReferencesWrittenAsDecoded(standIns, decodedRows)
    )
    return {
      links,
      linksByReferent: HashMap.fromIterable(
        links.map((link) => [Referent.key(link.referent), link] as const)
      ),
      linksByLogicalReference: linksByLogicalReferenceOf(links),
      standInByDecodedLiteralReference: standIns,
      chosenLinkTargetByMention: HashMap.empty(),
      resolvedResources,
      resolvedByLiteralReference: HashMap.fromIterable(
        resolvedResources.map((resolved) => [resolved.resolvedLiteralReference, resolved] as const)
      ),
    }
  })

/** The link target of the referent keyed `referentKey`, when it is a referent of the batch. */
const linkTargetIfReferentKey = (
  plan: Type,
  referentKey: LogicalReference.Key
): Option.Option<LinkTarget.Linked> =>
  Option.map(HashMap.get(plan.linksByReferent, referentKey), ({ target }) => target)

/**
 * The link target a mention choice gives its mention on `plan`: a
 * `LinkToStoredResource` that stored resource, a `DontLink` `Unlinked`, and a
 * `LinkToDecodedReferent` its referent's link target. `None` for a
 * `LinkToDecodedReferent` whose referent the batch does not hold: that
 * mention is redirected where its own referent's link target says, as one
 * with no choice is.
 */
const linkTargetOfChoice = (
  plan: Type,
  choice: LinkChoice.MentionLinkChoice
): Option.Option<LinkTarget.Type> =>
  Match.value(choice).pipe(
    Match.tag('LinkToStoredResource', ({ resource }) =>
      Option.some<LinkTarget.Type>(LinkTarget.Stored({ resource }))
    ),
    Match.tag('LinkToDecodedReferent', ({ referentKey }) =>
      Option.map(linkTargetIfReferentKey(plan, referentKey), (target): LinkTarget.Type => target)
    ),
    Match.tag('DontLink', () => Option.some(LinkTarget.Unlinked())),
    Match.exhaustive
  )

/**
 * `plan` with the reviewer's link choice set by mention, `byMention`, made
 * into the link target each chosen mention takes ({@link linkTargetOfChoice})
 * over the plan's links. The links and the resolved resources are kept: a
 * mention choice teaches nothing and writes nothing, so no resolved resource
 * assumes anything for it.
 */
const withMentionLinkChoiceSet = (plan: Type, byMention: MentionLinkChoiceSet.Type): Type => ({
  ...plan,
  chosenLinkTargetByMention: HashMap.filterMap(byMention, (choice) =>
    linkTargetOfChoice(plan, choice)
  ),
})

/** Every referent's link target, in discovery order. */
const linkTargets = (plan: Type): readonly LinkTarget.Linked[] =>
  plan.links.map(({ target }) => target)

/** The resource under each literal reference the links redirect to, as it will be written, in the order the links first reach it. */
const resolvedResources = (plan: Type): readonly ResolvedResource.Type[] => plan.resolvedResources

/**
 * The link of the referent a logical reference keyed `logicalReferenceKey`
 * names: the referent it is the key of, else the one referent that answers
 * to it (`Referent.logicalReferencesOf`). A logical reference several
 * referents answer to, and none is keyed by, names none of them.
 */
const linkIfNamedBy = (
  plan: Type,
  logicalReferenceKey: LogicalReference.Key
): Option.Option<Link.Type> =>
  Option.orElse(HashMap.get(plan.linksByReferent, logicalReferenceKey), () =>
    pipe(
      HashMap.get(plan.linksByLogicalReference, logicalReferenceKey),
      Option.filter((answering) => answering.length === 1),
      Option.map(Array.headNonEmpty)
    )
  )

/**
 * The literal reference `referenceAsDecoded` is redirected to under `plan`,
 * when it names a referent: for a decoded literal reference, the stored
 * resource that stands in for its decoded resource; for a logical reference,
 * its referent's link target. `None` when it names no such referent, so it
 * stays as decoded.
 */
const redirectionIfLinked = (
  plan: Type,
  referenceAsDecoded: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  Option.match(Option.fromNullable(referenceAsDecoded.reference), {
    onNone: () =>
      pipe(
        LinkableLogicalReference.tryFromReference(referenceAsDecoded),
        Option.flatMap((logicalReference) =>
          linkIfNamedBy(plan, LogicalReference.key(logicalReference))
        ),
        Option.map(({ target }) => LinkableResource.literalReferenceOf(target.resource))
      ),
    onSome: (decodedLiteralReference) =>
      Option.map(
        HashMap.get(plan.standInByDecodedLiteralReference, decodedLiteralReference),
        LinkableResource.literalReferenceOf
      ),
  })

/**
 * The resource `decodedResource` is written as under `plan`: the resolved
 * resource under the literal reference it is written under, a stored
 * resource's when one stands in for it and its own otherwise. `None` only for
 * a resource that is no referent, no Patient or Practitioner with a qualified
 * first identifier, which is written as decoded: every referent with a
 * resource has a resolved resource under the literal reference it is written
 * under.
 */
const resolvedResourceIfReferent = (
  plan: Type,
  decodedResource: FhirResourceWithId
): Option.Option<ResolvedResource.Type> =>
  pipe(
    Option.liftPredicate(decodedResource, LinkableResource.is),
    Option.map((linkable) =>
      resolvedLiteralReferenceOf(
        plan.standInByDecodedLiteralReference,
        LinkableResource.literalReferenceOf(linkable)
      )
    ),
    Option.flatMap((resolvedLiteralReference) =>
      HashMap.get(plan.resolvedByLiteralReference, resolvedLiteralReference)
    )
  )

/**
 * The link target the reviewer chose for `mention`, in the resource reviewed
 * under `reviewKey`, when they chose one it can take: `Unlinked`, or a
 * resource of the type the mention names. A target of another type is no
 * choice, so a `subject` is never redirected to a Practitioner. `None` when
 * the mention is redirected where its referent's link target says.
 */
const linkTargetIfChosenForMention = (
  plan: Type,
  reviewKey: string,
  mention: Mention.Linkable
): Option.Option<LinkTarget.Type> =>
  pipe(
    HashMap.get(plan.chosenLinkTargetByMention, MentionLinkChoiceSet.key(reviewKey, mention.path)),
    Option.filter((target) =>
      Option.match(LinkTarget.resourceIfLinked(target), {
        onNone: () => true,
        onSome: (resource) => resource.resourceType === mention.type,
      })
    )
  )

export {
  empty,
  linkTargetIfChosenForMention,
  linkTargetIfReferentKey,
  linkTargets,
  make,
  redirectionIfLinked,
  resolvedResourceIfReferent,
  resolvedResources,
  withMentionLinkChoiceSet,
}
export type { Type }
