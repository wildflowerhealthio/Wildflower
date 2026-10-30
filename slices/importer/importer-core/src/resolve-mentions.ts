import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type MentionLinkChoiceSet,
  type DecodedFile,
  FileResolution,
  type FormatDecode,
  type LinkChoice,
  type LinkChoiceSet,
  LinkPlan,
  PickedFile,
  Referent,
  ReferentLinkChoiceSet,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap } from 'effect'

import { type DecodedBatch, claimedFormats, collectFormats } from './read-batch.ts'
import { type FormatKind, formatRegistry } from './registry.ts'

/**
 * A batch's mentions resolved: one identity map for every format the batch
 * read, so the same person in a HAR and a PDF is one referent with one
 * choice, and every mention of it resolves to one resource. A resolved batch
 * is one whose mentions are resolved. Service-free: the screen holds the
 * choices and runs these on each change.
 *
 * @packageDocumentation
 */

/** The decoded file of every format `batch` claimed, in format order. */
const decodedFilesOf = (batch: DecodedBatch): readonly DecodedFile.DecodedFile[] =>
  claimedFormats(batch.formats).map((kind) => batch.formats[kind].decoded)

/**
 * Every referent the batch holds, once per identity across formats, in
 * format-then-review order, those with a resource first
 * (`Referent.discover`).
 *
 * @param batch - The decoded batch
 * @returns The referents the reviewer makes a link choice for
 */
const discoverReferents = (
  batch: DecodedBatch
): Effect.Effect<readonly Referent.Type[], Referent.DuplicateReferent> =>
  Referent.discover(decodedFilesOf(batch))

/**
 * A batch every mention of which resolves: the batch the diff, the preview
 * and the confirm see. Beside a decoded batch's slots it holds the linked
 * records and the plan it was resolved on, which a decoded batch cannot, and
 * the decoded batch itself. Each format slot's `decoded` holds that format's
 * resolved file.
 */
interface ResolvedBatch extends DecodedBatch {
  /**
   * The records the batch only mentions, written beside the files, each with
   * its origin (`FileResolution.linkedRecords`), keyed by
   * `FileResolution.linkedKey`.
   */
  readonly linkedRecords: readonly FileResolution.LinkedRecord[]
  /**
   * The plan the batch was resolved on: what the referent rows read each
   * choice's link target off, and what the review asks the referent links
   * leave unlinked in a resource (`UnlinkedMention.leftByReferentLinks`).
   */
  readonly plan: LinkPlan.Type
  /**
   * The batch as decoded, before any link was followed: the resources the
   * review asks the plan's referent links about, since a resolved resource
   * also carries the mention links.
   */
  readonly decodedBatch: DecodedBatch
}

/**
 * Whether `resource` is `kind`'s own source file: the `DocumentReference` its
 * `decode` minted for a picked file, filed under a patient at decode or
 * deliberately under none, so never one the review asks a patient for.
 */
const isSourceFileOf = (kind: FormatKind, resource: FhirResourceWithId): boolean =>
  resource.resourceType === 'DocumentReference' &&
  PickedFile.isSourceFile(formatRegistry[kind].sourceFileFormat)(resource)

/**
 * `kind`'s slot of `batch` with its decoded file resolved on `plan`
 * (`FileResolution.resolveFile`); the slot itself when nothing moved in it.
 */
const resolveFormat = <K extends FormatKind>(
  plan: LinkPlan.Type,
  batch: DecodedBatch,
  kind: K
): FormatDecode.Result<K> => {
  const result = batch.formats[kind]
  const resolved = FileResolution.resolveFile(plan)(result.decoded)
  return resolved === result.decoded ? result : { ...result, decoded: resolved }
}

/** The plan for `batch` on `linkChoiceSet`: its links by referent, then its mention links. */
const planOf = (
  batch: DecodedBatch,
  linkChoiceSet: LinkChoiceSet.Type
): Effect.Effect<LinkPlan.Type, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.map(LinkPlan.make(decodedFilesOf(batch), linkChoiceSet.byReferent), (plan) =>
    LinkPlan.withMentionLinkChoiceSet(plan, linkChoiceSet.byMention)
  )

/**
 * The batch with every mention resolved to its referent's link target, or
 * the one the reviewer chose for it on its own, the records only mentioned
 * gathered to be written as its `linkedRecords`, and the plan it was
 * resolved on: the batch to review, diff and write.
 *
 * @param batch - The decoded batch
 * @param linkChoiceSet - The reviewer's link choice set: by referent, and by
 *   mention for a mention chosen for on its own
 * @returns The resolved batch
 *
 * @remarks
 * One plan over the batch's referents ({@link planOf}: `LinkPlan.make` over
 * every claimed format's decoded file, the mention links laid on it with
 * `LinkPlan.withMentionLinkChoiceSet`), and each format resolved on it once,
 * in its own slot ({@link resolveFormat}): the choices are made for the
 * decoded files' referents, so a mention in one format links to a referent
 * another holds, and a review key is unique across the batch, so a mention
 * link names one mention of one format's resource. The resources the batch
 * only mentions are its `linkedRecords`, no format's, so a stored person
 * several formats only mention is written once. Section titles and review
 * keys are kept, so the selections survive, and a slot nothing moved in
 * comes back as it was. A batch with no claimed format comes back with no
 * linked records and an empty plan. Which of a person's names is current is
 * judged at the clock's now, so the clock is the one input besides the
 * arguments. Fails with `Referent.DuplicateReferent` when two decoded
 * resources under different ids are keyed by one logical reference, and
 * with `LinkChoice.InvalidLinkChoice` when a choice cannot be followed for
 * its referent; a mention link choice its mention cannot take is no choice,
 * so that mention is redirected to its referent's link target.
 */
const resolveMentions = (
  batch: DecodedBatch,
  linkChoiceSet: LinkChoiceSet.Type
): Effect.Effect<ResolvedBatch, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.flatMap(planOf(batch, linkChoiceSet), (plan) =>
    Effect.map(
      collectFormats((kind) => Effect.succeed(resolveFormat(plan, batch, kind))),
      (formats): ResolvedBatch => ({
        formats,
        unrecognizedFiles: batch.unrecognizedFiles,
        linkedRecords: FileResolution.linkedRecords(plan),
        plan,
        decodedBatch: batch,
      })
    )
  )

/**
 * `batch` with its mentions resolved on the reviewer's `chosen` choices over
 * the searched `defaults`, and on their link choice set `byMention`, where a
 * referent choice that cannot be resolved (`InvalidLinkChoice`) falls back:
 * the reviewer's own choice to its searched default, a default to its kind's
 * default. A re-decode may have changed a referent's kind, or removed the
 * referent a choice linked to.
 *
 * @param batch - The decoded batch
 * @param defaults - The searched default choices, by `Referent.key`
 * @param chosen - The reviewer's own choices, by `Referent.key`, over the defaults
 * @param byMention - The reviewer's link choice set by mention, by
 *   `MentionLinkChoiceSet.key`
 * @returns The resolved `batch` and the link choice set by referent, `linkChoices`, it was
 *   resolved on
 *
 * @remarks
 * Each failure names the choice that could not be resolved, and the fallback
 * drops it, the reviewer's own first, then the default. A failure naming a
 * referent with no choice at all is a defect in the stage's defaults, so it
 * dies rather than loop. A mention link choice never fails: one its mention
 * cannot take is no choice.
 */
const resolveMentionsWithFallback = (
  batch: DecodedBatch,
  defaults: ReferentLinkChoiceSet.Type,
  chosen: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type
): Effect.Effect<
  { readonly batch: ResolvedBatch; readonly linkChoices: ReferentLinkChoiceSet.Type },
  Referent.DuplicateReferent
> => {
  const linkChoices = ReferentLinkChoiceSet.union(defaults, chosen)
  return resolveMentions(batch, { byReferent: linkChoices, byMention }).pipe(
    Effect.map((resolved) => ({ batch: resolved, linkChoices })),
    Effect.catchTag('InvalidLinkChoice', (failure) => {
      if (HashMap.has(chosen, failure.referentKey)) {
        return resolveMentionsWithFallback(
          batch,
          defaults,
          ReferentLinkChoiceSet.remove(chosen, failure.referentKey),
          byMention
        )
      }
      if (HashMap.has(defaults, failure.referentKey)) {
        return resolveMentionsWithFallback(
          batch,
          ReferentLinkChoiceSet.remove(defaults, failure.referentKey),
          chosen,
          byMention
        )
      }
      return Effect.die(
        new Error(
          `a kind's default choice could not be resolved: ${failure.reason} for ${failure.referentKey}`
        )
      )
    })
  )
}

export { discoverReferents, isSourceFileOf, resolveMentions, resolveMentionsWithFallback }
export type { ResolvedBatch }
