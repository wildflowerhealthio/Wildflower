import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type MentionLinkChoiceSet,
  DecodedFile,
  FileResolution,
  type FormatDecode,
  type LinkChoice,
  type LinkChoiceSet,
  LinkPlan,
  PickedFile,
  Referent,
  ReferentLinkChoiceSet,
  UnlinkedMention,
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
 * records, every referent's link target and what each format still leaves
 * unlinked, which a decoded batch cannot. Each format slot's `decoded` holds
 * that format's resolved file.
 */
interface ResolvedBatch extends DecodedBatch {
  /**
   * The records the batch only mentions, written beside the files, each with
   * its origin (`FileResolution.linkedRecords`), keyed by
   * `FileResolution.linkedKey`.
   */
  readonly linkedRecords: readonly FileResolution.LinkedRecord[]
  /** The plan the batch was resolved on: what the referent rows read each choice's link target off. */
  readonly plan: LinkPlan.Type
  /**
   * What the referent link choices alone leave unlinked in each claimed
   * format (`UnlinkedMention.collect`), the format's own source files aside:
   * the resources the review lists as needing a patient or a provider. A
   * mention the reviewer chose a link for on its own is landed in the
   * format's resolved file and still counted here, so the row it is on stays
   * listed, and in focus, once picked.
   */
  readonly unlinkedMentionsByFormatKind: HashMap.HashMap<
    FormatKind,
    readonly UnlinkedMention.Type[]
  >
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
 * What the referent link choices alone leave unlinked in `kind`'s decoded
 * file: `UnlinkedMention.collect` on the file resolved on the plan before any
 * mention link choice, `kind`'s source files aside.
 */
const unlinkedMentionsOf = (
  kind: FormatKind,
  resolvedOnReferents: FormatDecode.Result<FormatKind>['decoded']
): readonly UnlinkedMention.Type[] => {
  const sourceFileKeys = new Set(
    DecodedFile.resources(resolvedOnReferents)
      .filter(({ resource }) => isSourceFileOf(kind, resource))
      .map(({ key }) => key)
  )
  return UnlinkedMention.collect(resolvedOnReferents).filter(
    ({ mentioningResourceKey }) => !sourceFileKeys.has(mentioningResourceKey)
  )
}

/**
 * The batch with every mention resolved to the target its referent's choice
 * gives, or the one the reviewer chose for it on its own, the records only
 * mentioned gathered to be written as its `linkedRecords`, every referent's
 * link target, and what each format is left needing: the batch to review,
 * diff and write.
 *
 * @param batch - The decoded batch
 * @param linkChoiceSet - The reviewer's link choice set: by referent, and by
 *   mention for a mention chosen for on its own
 * @returns The resolved batch
 *
 * @remarks
 * Every claimed format is resolved on one plan over the batch's referents
 * (`LinkPlan.make` over every claimed format's decoded file, the mention link
 * choices laid on it with `LinkPlan.withMentionLinkChoiceSet`), each format in
 * its own slot (`FileResolution.resolveFile`): the choices are made for the
 * decoded files' referents, so a mention in one format links to a referent
 * another holds, and a review key is unique across the batch, so a mention
 * link choice names one mention of one format's resource. The resources the
 * batch only mentions are its `linkedRecords`, no format's, so a stored
 * person several formats only mention is written once, and the plan it was
 * resolved on is its `plan`. Each format's
 * `unlinkedMentionsByFormatKind` are read off the file resolved on the
 * referent choices alone, so a mention link choice takes nothing out of
 * them. Section titles and review keys are kept, so the selections survive,
 * and a slot nothing moved in comes back as it was. A batch with no claimed
 * format comes back with no linked records, an empty plan and nothing
 * unlinked. Which of a person's names is current is judged at the clock's
 * now, so the clock is the one input besides the arguments. Fails with
 * `Referent.DuplicateReferent` when two decoded resources under different
 * ids are keyed by one logical reference, and with
 * `LinkChoice.InvalidLinkChoice` when a choice cannot be followed for its
 * referent; a mention link choice its mention cannot take is no choice, so
 * that mention lands where its referent's choice says.
 */
const resolveMentions = (
  batch: DecodedBatch,
  linkChoiceSet: LinkChoiceSet.Type
): Effect.Effect<ResolvedBatch, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.flatMap(
    LinkPlan.make(decodedFilesOf(batch), linkChoiceSet.byReferent),
    (planOnReferents) => {
      const plan = LinkPlan.withMentionLinkChoiceSet(planOnReferents, linkChoiceSet.byMention)
      const unlinked: [FormatKind, readonly UnlinkedMention.Type[]][] = []
      return Effect.map(
        collectFormats(<K extends FormatKind>(kind: K): Effect.Effect<FormatDecode.Result<K>> => {
          const result = batch.formats[kind]
          if (result.files.length === 0) return Effect.succeed(result)
          const resolvedOnReferents = FileResolution.resolveFile(planOnReferents)(result.decoded)
          unlinked.push([kind, unlinkedMentionsOf(kind, resolvedOnReferents)])
          const decoded =
            plan === planOnReferents
              ? resolvedOnReferents
              : FileResolution.resolveFile(plan)(result.decoded)
          // A slot nothing moved in comes back as itself.
          return Effect.succeed(decoded === result.decoded ? result : { ...result, decoded })
        }),
        (formats): ResolvedBatch => ({
          formats,
          unrecognizedFiles: batch.unrecognizedFiles,
          linkedRecords: FileResolution.linkedRecords(plan),
          plan,
          unlinkedMentionsByFormatKind: HashMap.fromIterable(unlinked),
        })
      )
    }
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

export { discoverReferents, resolveMentions, resolveMentionsWithFallback }
export type { ResolvedBatch }
