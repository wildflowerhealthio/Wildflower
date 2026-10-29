/**
 * The link plan: everything resolving a batch's decoded files on the link
 * choices needs, worked out once from the files and the choices, and the
 * lookups that answer the resolution's and the redirection's questions.
 *
 * @remarks
 * A referent's mentions are redirected to its link target. The plan says what
 * each referent's link target is, what the resource under each resolved
 * literal reference becomes once it has assumed the identifiers of the
 * referents linked to it, and which decoded literal references move to a
 * stored resource. A mention the reviewer chose a link for on its own lands
 * where that choice says instead, and the plan resolves that too
 * ({@link withMentionLinkChoiceSet}). Built once per batch by {@link make}, so
 * a referent one file holds is the link target of a mention in another, and
 * read through {@link redirectionIfLinked}, {@link resolvedResourceIfReferent}
 * and {@link linkTargetIfChosenForMention} by the resolution of every file.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, Effect, HashMap, HashSet, Match, Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
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
  /** Each referent's link target, by `Referent.key`: what a `LinkToDecodedReferent` mention choice lands on. */
  readonly linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>
  /**
   * Each referent's link target under every logical reference that names it
   * (`Referent.byLogicalReferenceKey`), by `LinkableLogicalReference.key`:
   * where a logical-reference mention is redirected.
   */
  readonly linkTargetsByLogicalReferenceKey: HashMap.HashMap<string, LinkTarget.Type>
  /**
   * The resource under each resolved literal reference the links land on, as
   * it will be written: what replaces a decoded resource, what a decoded
   * resource assumes, and what the batch's linked records are.
   */
  readonly resolvedResourcesByResolvedLiteralReference: HashMap.HashMap<
    string,
    ResolvedResource.Type
  >
  /**
   * `Type/<decoded id>` → `Type/<stored id>` for every decoded resource a
   * stored resource stands in for: where a decoded literal reference is
   * redirected, and under which literal reference the resource is written.
   */
  readonly decodedLiteralReferencesToStored: HashMap.HashMap<string, string>
  /**
   * Where each mention the reviewer chose a link for on its own lands, by
   * `MentionLinkChoiceSet.key`, over its referent's rule: a stored resource, a
   * referent's link target, or `Unlinked`. Empty until
   * {@link withMentionLinkChoiceSet} lays the mention link choices on the plan.
   */
  readonly linkTargetsByMentionKey: HashMap.HashMap<string, LinkTarget.Type>
}

/** The literal references the decoded resources of `decodedFiles` the identity map links carry. */
const literalReferencesFromDecodedFiles = (
  decodedFiles: readonly DecodedFile.DecodedFile[]
): HashSet.HashSet<string> =>
  pipe(
    decodedFiles.flatMap(DecodedFile.resources),
    Array.filterMap(({ resource }) =>
      Option.liftPredicate(resource, LinkableResource.is).pipe(
        Option.map(LinkableResource.literalReferenceOf)
      )
    ),
    HashSet.fromIterable
  )

/**
 * The literal references of `decodedLiteralReferences` the batch writes where
 * they were decoded: those `decodedLiteralReferencesToStored` does not move
 * to another stored resource. A decoded resource a stored one under another
 * id replaces is not written under its own literal reference, so a stored
 * copy under that reference, which a mention may link to, is not written by
 * any resolved file.
 */
const writtenAsDecoded = (
  decodedLiteralReferences: HashSet.HashSet<string>,
  decodedLiteralReferencesToStored: HashMap.HashMap<string, string>
): HashSet.HashSet<string> =>
  HashSet.filter(decodedLiteralReferences, (decodedLiteralReference) =>
    HashMap.get(decodedLiteralReferencesToStored, decodedLiteralReference).pipe(
      Option.match({
        onNone: () => true,
        onSome: (storedLiteralReference) => storedLiteralReference === decodedLiteralReference,
      })
    )
  )

/**
 * `Type/<decoded id>` → `Type/<stored id>` for every referent of `links` whose
 * decoded resource a stored resource stands in for.
 */
const decodedLiteralReferencesToStoredOf = (
  links: readonly Link.Type[]
): HashMap.HashMap<string, string> =>
  pipe(
    links,
    Array.filterMap(({ referent, target }) =>
      Option.all({
        asResource: Option.liftPredicate(referent, Referent.is('AsResource')),
        stored: Option.liftPredicate(target, LinkTarget.is('Stored')),
      })
    ),
    Array.map(
      ({ asResource, stored }) =>
        [
          LinkableResource.literalReferenceOf(asResource.resource),
          LinkableResource.literalReferenceOf(stored.resource),
        ] as const
    ),
    HashMap.fromIterable
  )

/** Each link's target by its referent's key. */
const linkTargetsByReferentKeyOf = (
  links: readonly Link.Type[]
): HashMap.HashMap<string, LinkTarget.Type> =>
  HashMap.fromIterable(
    links.map(({ referent, target }) => [Referent.key(referent), target] as const)
  )

/** Each link's target under every logical reference that names its referent (`Referent.byLogicalReferenceKey`). */
const linkTargetsByLogicalReferenceKeyOf = (
  links: readonly Link.Type[],
  linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>
): HashMap.HashMap<string, LinkTarget.Type> =>
  HashMap.filterMap(
    Referent.byLogicalReferenceKey(links.map(({ referent }) => referent)),
    (referent) => HashMap.get(linkTargetsByReferentKey, Referent.key(referent))
  )

/**
 * The plan for a batch's `decodedFiles` on the link choice set by referent,
 * `byReferent`:
 * each referent's choice made once into its link (`Link.fromChoices`), and
 * every field read off those links; no mention chosen for on its own yet
 * ({@link withMentionLinkChoiceSet}).
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
    const linkTargetsByReferentKey = linkTargetsByReferentKeyOf(links)
    const decodedLiteralReferencesToStored = decodedLiteralReferencesToStoredOf(links)
    const resolvedResourcesByResolvedLiteralReference =
      yield* ResolvedResource.byResolvedLiteralReference(
        links,
        writtenAsDecoded(
          literalReferencesFromDecodedFiles(decodedFiles),
          decodedLiteralReferencesToStored
        )
      )
    return {
      links,
      linkTargetsByReferentKey,
      linkTargetsByLogicalReferenceKey: linkTargetsByLogicalReferenceKeyOf(
        links,
        linkTargetsByReferentKey
      ),
      resolvedResourcesByResolvedLiteralReference,
      decodedLiteralReferencesToStored,
      linkTargetsByMentionKey: HashMap.empty(),
    }
  })

/**
 * Where a mention link choice lands, given every referent's link target: a
 * `LinkToStoredResource` on that stored resource, a `DontLink` nowhere, and
 * a `LinkToDecodedReferent` where its referent does. `None` for a
 * `LinkToDecodedReferent` whose referent lands on no resource, or that the
 * batch does not hold: that mention lands where its own referent does, as
 * one with no choice does.
 *
 * @remarks
 * Only an explicit `DontLink` unlinks a mention. Resolving a resolved batch
 * again discovers no referent for an identity whose every mention was
 * redirected, so reading a missing referent as unlinked would move a mention
 * the first resolution had landed.
 */
const linkTargetOfMentionChoice = (
  linkTargetsByReferentKey: HashMap.HashMap<string, LinkTarget.Type>,
  choice: LinkChoice.MentionLinkChoice
): Option.Option<LinkTarget.Type> =>
  Match.value(choice).pipe(
    Match.tag('LinkToStoredResource', ({ resource }) =>
      Option.some(LinkTarget.Stored({ resource }))
    ),
    Match.tag('LinkToDecodedReferent', ({ referentKey }) =>
      HashMap.get(linkTargetsByReferentKey, referentKey).pipe(
        Option.filter((target) => !LinkTarget.is('Unlinked')(target))
      )
    ),
    Match.tag('DontLink', () => Option.some(LinkTarget.Unlinked())),
    Match.exhaustive
  )

/**
 * `plan` with the reviewer's link choice set by mention, `byMention`, laid on
 * it: each chosen
 * mention's link target, resolved off the referents' link targets the plan
 * already holds. Every other field is kept: the mention link choices teach
 * nothing and write nothing, so no resolved resource assumes anything for
 * them.
 */
const withMentionLinkChoiceSet = (plan: Type, byMention: MentionLinkChoiceSet.Type): Type =>
  HashMap.isEmpty(byMention)
    ? plan
    : {
        ...plan,
        linkTargetsByMentionKey: HashMap.filterMap(byMention, (choice) =>
          linkTargetOfMentionChoice(plan.linkTargetsByReferentKey, choice)
        ),
      }

/**
 * The link target the reviewer chose for `mention`, in the resource reviewed
 * under `reviewKey`, when they chose one it can take: `Unlinked`, or a
 * resource of the type the mention names. A target of another type is no
 * choice, so a `subject` never lands on a Practitioner. `None` when the
 * mention lands where its referent's choice says.
 */
const linkTargetIfChosenForMention = (
  plan: Type,
  reviewKey: string,
  mention: Mention.Linkable
): Option.Option<LinkTarget.Type> =>
  HashMap.get(plan.linkTargetsByMentionKey, MentionLinkChoiceSet.key(reviewKey, mention.path)).pipe(
    Option.filter((target) =>
      Option.match(LinkTarget.resourceIfLinked(target), {
        onNone: () => true,
        onSome: (resource) => resource.resourceType === mention.type,
      })
    )
  )

/**
 * The literal reference `referenceAsDecoded` is redirected to under `plan`,
 * when it names a referent whose link lands on a resource it does not already
 * name: for a decoded literal reference, the stored one that stands in for its
 * decoded resource; for a logical reference, its referent's link target.
 * `None` when it names no such referent, so it stays as decoded.
 */
const redirectionIfLinked = (
  plan: Type,
  referenceAsDecoded: IdentifierAndReference.ReferenceType
): Option.Option<string> =>
  referenceAsDecoded.reference === null
    ? pipe(
        LinkableLogicalReference.tryFromReference(referenceAsDecoded),
        Option.map(LinkableLogicalReference.key),
        Option.flatMap((logicalReferenceKey) =>
          HashMap.get(plan.linkTargetsByLogicalReferenceKey, logicalReferenceKey)
        ),
        Option.flatMap(LinkTarget.resourceIfLinked),
        Option.map(LinkableResource.literalReferenceOf)
      )
    : HashMap.get(plan.decodedLiteralReferencesToStored, referenceAsDecoded.reference)

/**
 * The literal reference a decoded resource under `decodedLiteralReference` is
 * written under: the stored one that stands in for it, else its own.
 */
const resolvedLiteralReferenceOf = (plan: Type, decodedLiteralReference: string): string =>
  HashMap.get(plan.decodedLiteralReferencesToStored, decodedLiteralReference).pipe(
    Option.getOrElse(() => decodedLiteralReference)
  )

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
      resolvedLiteralReferenceOf(plan, LinkableResource.literalReferenceOf(linkable))
    ),
    Option.flatMap((resolvedLiteralReference) =>
      HashMap.get(plan.resolvedResourcesByResolvedLiteralReference, resolvedLiteralReference)
    )
  )

export {
  linkTargetIfChosenForMention,
  make,
  redirectionIfLinked,
  resolvedResourceIfReferent,
  withMentionLinkChoiceSet,
}
export type { Type }
