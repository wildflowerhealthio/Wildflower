import {
  FileResolution,
  type FormatDecode,
  type Link,
  type LinkChoice,
  LinkPlan,
  Referent,
  ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap } from 'effect'

import {
  type DecodedBatch,
  claimedFormats,
  collectFormats,
  type FormatResults,
} from './read-batch.ts'
import type { FormatKind } from './registry.ts'

/**
 * A batch's mentions resolved: one identity map for every format the batch
 * read, so the same person in a HAR and a PDF is one referent with one
 * choice, and every mention of it resolves to one resource. A resolved batch
 * is one whose mentions are resolved. Service-free: the screen holds the
 * choices and runs these on each change.
 *
 * @packageDocumentation
 */

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
  Referent.discover(claimedFormats(batch).map((kind) => batch[kind].decoded))

/**
 * A batch every mention of which resolves: the batch the diff, the preview
 * and the confirm see. Beside a decoded batch's slots it holds the linked
 * records and every referent's link, which a decoded batch cannot.
 */
type ResolvedBatch = DecodedBatch & {
  /**
   * The batch's linked records: the records it only mentions, as they will
   * be written, each with its origin (`FileResolution.linkedRecords`), keyed
   * by `FileResolution.linkedKey`. The batch's own slot, no format's.
   */
  readonly linked: readonly FileResolution.LinkedRecord[]
  /** Every referent of the batch with its link target, in discovery order (the plan's `links`). */
  readonly links: readonly Link.Type[]
}

/**
 * The batch with every mention resolved to the target its referent's choice
 * in `linkChoices` gives, the records only mentioned gathered to be written
 * in its `linked` slot, and every referent's link: the batch to review, diff
 * and write.
 *
 * @param batch - The decoded batch
 * @param linkChoices - The reviewer's link choices, by `Referent.key`
 * @returns The resolved batch
 *
 * @remarks
 * Every claimed format is resolved on one plan over the batch's referents
 * (`LinkPlan.make` over every claimed format's decoded file), each format in
 * its own slot (`FileResolution.resolveFile`): the choices are made for the
 * decoded files' referents, so a mention in one format links to a referent
 * another holds. The resources the batch only mentions are its `linked`
 * slot, no format's, so a stored person several formats only mention is
 * written once, and the plan's `links` are its `links`. Section titles and
 * review keys are kept, so the selections survive, and a slot nothing moved
 * in comes back as it was. A batch with no claimed format comes back with no
 * linked records and no links. Which of a person's names is current is
 * judged at the clock's now, so the clock is the one input besides the
 * arguments. Fails with `Referent.DuplicateReferent` when two
 * decoded resources under different ids are keyed by one logical reference,
 * and with `LinkChoice.InvalidLinkChoice` when a choice cannot be followed
 * for its referent.
 */
const resolveMentions = (
  batch: DecodedBatch,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<ResolvedBatch, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.flatMap(
    LinkPlan.make(
      claimedFormats(batch).map((kind) => batch[kind].decoded),
      linkChoices
    ),
    (plan) => {
      // Read slots through FormatResults, as `redecodeFormat` does, so each is its own `Result<K>`.
      const results: FormatResults = batch
      return Effect.map(
        collectFormats(<K extends FormatKind>(kind: K): Effect.Effect<FormatDecode.Result<K>> => {
          const result = results[kind]
          const decoded = FileResolution.resolveFile(plan)(result.decoded)
          // A slot nothing moved in comes back as itself, an unclaimed one among them.
          return Effect.succeed(decoded === result.decoded ? result : { ...result, decoded })
        }, batch.unrecognizedFiles),
        (resolvedFormats): ResolvedBatch => ({
          ...resolvedFormats,
          linked: FileResolution.linkedRecords(plan),
          links: plan.links,
        })
      )
    }
  )

/**
 * `batch` with its mentions resolved on the reviewer's `chosen` choices over
 * the searched `defaults`, where a choice that cannot be resolved
 * (`InvalidLinkChoice`) falls back: the reviewer's own choice to its searched
 * default, a default to its kind's default. A re-decode may have changed a
 * referent's kind, or removed the referent a choice linked to.
 *
 * @param batch - The decoded batch
 * @param defaults - The searched default choices, by `Referent.key`
 * @param chosen - The reviewer's own choices, by `Referent.key`, over the defaults
 * @returns The resolved `batch` and the `linkChoices` it was resolved on
 *
 * @remarks
 * Each failure names the choice that could not be resolved, and the fallback
 * drops it, the reviewer's own first, then the default. A failure naming a
 * referent with no choice at all is a defect in the stage's defaults, so it
 * dies rather than loop.
 */
const resolveMentionsWithFallback = (
  batch: DecodedBatch,
  defaults: ReferentLinkChoices.Type,
  chosen: ReferentLinkChoices.Type
): Effect.Effect<
  { readonly batch: ResolvedBatch; readonly linkChoices: ReferentLinkChoices.Type },
  Referent.DuplicateReferent
> => {
  const linkChoices = ReferentLinkChoices.union(defaults, chosen)
  return resolveMentions(batch, linkChoices).pipe(
    Effect.map((resolved) => ({ batch: resolved, linkChoices })),
    Effect.catchTag('InvalidLinkChoice', (failure) => {
      if (HashMap.has(chosen, failure.referentKey)) {
        return resolveMentionsWithFallback(
          batch,
          defaults,
          ReferentLinkChoices.remove(chosen, failure.referentKey)
        )
      }
      if (HashMap.has(defaults, failure.referentKey)) {
        return resolveMentionsWithFallback(
          batch,
          ReferentLinkChoices.remove(defaults, failure.referentKey),
          chosen
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
