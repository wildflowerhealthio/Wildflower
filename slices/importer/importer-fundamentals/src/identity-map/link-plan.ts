/**
 * The link plan: the reviewer's choices made into links, worked out once for
 * a batch, and the questions the resolution and the review ask of it.
 *
 * @remarks
 * The reviewer's choices become links, the links are the plan, the plan
 * resolves the batch, and the screen offers what the plan will write. The
 * plan is three lists:
 *
 * - **links**: each referent with its link target, made from the link
 *   choice set by referent (`Link.fromChoices`);
 * - **mention links**: each mention the reviewer chose a link for on its own
 *   with its link target, made from the link choice set by mention
 *   (`MentionLink.fromChoices`, laid on by {@link withMentionLinkChoiceSet});
 * - **resolved resources**: the resource under each literal reference the
 *   links redirect to, as it will be written, having assumed the identifiers
 *   of every referent linked to it (`ResolvedResource.fromLinks`).
 *
 * Every question is a search over those lists. Outside this module the plan
 * is read only through its questions: {@link linkTargetIfReferentKey},
 * {@link linkTargets}, {@link redirectionIfLinked},
 * {@link resolvedResourceIfReferent}, {@link linkTargetIfChosenForMention}
 * and {@link resolvedResources}. Built once per batch by {@link make}, so a
 * referent one file holds is the link target of a mention in another.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import * as Link from './link.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as MentionLinkChoiceSet from './mention-link-choice-set.ts'
import * as MentionLink from './mention-link.ts'
import type * as Mention from './mention.ts'
import type * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'
import * as ResolvedResource from './resolved-resource.ts'

/** The link plan for a batch's decoded files, built once by {@link make}. */
interface Type {
  /** Every referent of the batch with its link target, in discovery order. */
  readonly links: readonly Link.Type[]
  /** Every mention chosen for on its own with its link target; none until {@link withMentionLinkChoiceSet}. */
  readonly mentionLinks: readonly MentionLink.Type[]
  /** The resource under each literal reference the links redirect to, as it will be written. */
  readonly resolvedResources: readonly ResolvedResource.Type[]
}

/** The plan of a batch with no referent: no links, no mention links, no resolved resources. */
const empty: Type = { links: [], mentionLinks: [], resolvedResources: [] }

/**
 * The stored resource standing in for the decoded resource under
 * `decodedLiteralReference`, when `links` link the referent whose decoded
 * resource it is to a stored one.
 */
const storedStandInIfLinked = (
  links: readonly Link.Type[],
  decodedLiteralReference: string
): Option.Option<LinkableResource.WithId> =>
  Array.findFirst(links, ({ referent, target }) =>
    Option.all({
      asResource: Option.liftPredicate(referent, Referent.is('AsResource')),
      stored: Option.liftPredicate(target, LinkTarget.is('Stored')),
    }).pipe(
      Option.filter(
        ({ asResource }) =>
          LinkableResource.literalReferenceOf(asResource.resource) === decodedLiteralReference
      ),
      Option.map(({ stored }) => stored.resource)
    )
  )

/**
 * The literal reference the decoded resource under `decodedLiteralReference`
 * is written under: the stored stand-in's, else its own.
 */
const resolvedLiteralReferenceOf = (
  links: readonly Link.Type[],
  decodedLiteralReference: string
): string =>
  Option.match(storedStandInIfLinked(links, decodedLiteralReference), {
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
    decodedFiles.flatMap(DecodedFile.resources),
    Array.filterMap(({ resource }) =>
      Option.map(
        Option.liftPredicate(resource, LinkableResource.is),
        LinkableResource.literalReferenceOf
      )
    ),
    Array.filter(
      (decodedLiteralReference) =>
        resolvedLiteralReferenceOf(links, decodedLiteralReference) === decodedLiteralReference
    )
  )

/**
 * The plan for a batch's `decodedFiles` on the link choice set by referent,
 * `byReferent`: each referent's choice made once into its link
 * (`Link.fromChoices`), and the resolved resources those links redirect to;
 * no mention link yet ({@link withMentionLinkChoiceSet}).
 *
 * @remarks
 * The referents are the whole batch's (`Referent.discover`), so a
 * `LinkToDecodedReferent` naming a referent one file holds is the link
 * target of a mention in another, and every file is resolved on the same
 * plan. Fails with `Referent.DuplicateReferent` when two decoded resources
 * answer to one logical reference, and with `LinkChoice.InvalidLinkChoice`
 * when a choice cannot be followed for its referent.
 */
const make = (
  decodedFiles: readonly DecodedFile.DecodedFile[],
  byReferent: ReferentLinkChoiceSet.Type
): Effect.Effect<Type, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.gen(function* () {
    const referents = yield* Referent.discover(decodedFiles)
    const links = yield* Link.fromChoices(referents, byReferent)
    const resolvedResources = yield* ResolvedResource.fromLinks(
      links,
      literalReferencesWrittenAsDecoded(links, decodedFiles)
    )
    return { links, mentionLinks: [], resolvedResources }
  })

/**
 * `plan` with the reviewer's link choice set by mention, `byMention`, made
 * into its mention links (`MentionLink.fromChoices`) over the plan's links.
 * The links and the resolved resources are kept: a mention choice teaches
 * nothing and writes nothing, so no resolved resource assumes anything for
 * it.
 */
const withMentionLinkChoiceSet = (plan: Type, byMention: MentionLinkChoiceSet.Type): Type => ({
  ...plan,
  mentionLinks: MentionLink.fromChoices(plan.links, byMention),
})

/** The link target of the referent keyed `referentKey`, when it is a referent of the batch. */
const linkTargetIfReferentKey = (plan: Type, referentKey: string): Option.Option<LinkTarget.Type> =>
  Link.targetIfReferentKey(plan.links, referentKey)

/** Every referent's link target, in discovery order. */
const linkTargets = (plan: Type): readonly LinkTarget.Type[] =>
  plan.links.map(({ target }) => target)

/** The resource under each literal reference the links redirect to, as it will be written, in the order the links first reach it. */
const resolvedResources = (plan: Type): readonly ResolvedResource.Type[] => plan.resolvedResources

/**
 * The link of the referent a logical reference keyed `logicalReferenceKey`
 * names: the referent it is the key of, else the one referent that answers
 * to it (`Referent.logicalReferencesOf`). A logical reference several
 * referents answer to, and none is keyed by, names none of them.
 */
const linkIfNamedBy = (plan: Type, logicalReferenceKey: string): Option.Option<Link.Type> =>
  Option.orElse(
    Array.findFirst(plan.links, ({ referent }) => Referent.key(referent) === logicalReferenceKey),
    () =>
      pipe(
        plan.links,
        Array.filter(({ referent }) =>
          Referent.logicalReferencesOf(referent).some(
            (logicalReference) =>
              LinkableLogicalReference.key(logicalReference) === logicalReferenceKey
          )
        ),
        Option.liftPredicate((answering) => answering.length === 1),
        Option.flatMap(Array.head)
      )
  )

/**
 * The literal reference `referenceAsDecoded` is redirected to under `plan`,
 * when it names a referent whose link target holds a resource: for a decoded
 * literal reference, the stored resource that stands in for its decoded
 * resource; for a logical reference, its referent's link target. `None`
 * when it names no such referent, so it stays as decoded.
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
          linkIfNamedBy(plan, LinkableLogicalReference.key(logicalReference))
        ),
        Option.flatMap(({ target }) => LinkTarget.resourceIfLinked(target)),
        Option.map(LinkableResource.literalReferenceOf)
      ),
    onSome: (decodedLiteralReference) =>
      Option.map(
        storedStandInIfLinked(plan.links, decodedLiteralReference),
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
      resolvedLiteralReferenceOf(plan.links, LinkableResource.literalReferenceOf(linkable))
    ),
    Option.flatMap((resolvedLiteralReference) =>
      Array.findFirst(
        plan.resolvedResources,
        (resolvedResource) => resolvedResource.resolvedLiteralReference === resolvedLiteralReference
      )
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
    Array.findFirst(
      plan.mentionLinks,
      (mentionLink) => mentionLink.reviewKey === reviewKey && mentionLink.path === mention.path
    ),
    Option.map(({ target }) => target),
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
