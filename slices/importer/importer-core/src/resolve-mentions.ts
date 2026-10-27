import {
  type DecodedFile,
  type FormatDecode,
  IdentityMap,
  type Link,
  type LinkChoice,
  Referent,
  type ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Effect, HashMap, Option } from 'effect'

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
   * The batch's linked records: the resources it only mentions, as the
   * identity map writes them (`IdentityMap.PlacedBatch`'s `linked`), keyed
   * by `Placement.linkedKey`. The batch's own slot, no format's.
   */
  readonly linked: readonly DecodedFile.Resource[]
  /** Every referent of the batch with its link target, in discovery order (`IdentityMap.PlacedBatch`'s `links`). */
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
 * (`IdentityMap.apply`), so a mention in one format links to a referent
 * another holds, and the resources the batch only mentions are its `linked`
 * slot, no format's, so a stored person several formats only mention is
 * written once. Section titles and review keys are kept, so the selections
 * survive. A batch with no claimed format is resolved as it is, with no
 * linked records and no links. Fails as `IdentityMap.apply` does.
 */
const resolveMentions = (
  batch: DecodedBatch,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<ResolvedBatch, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Array.match(claimedFormats(batch), {
    onEmpty: () => Effect.succeed({ ...batch, linked: [], links: [] }),
    onNonEmpty: (claimed) =>
      Effect.flatMap(
        IdentityMap.apply(
          Array.map(claimed, (kind) => batch[kind].decoded),
          linkChoices
        ),
        ({ placedFiles, linked, links }) => {
          const resolvedByKind: HashMap.HashMap<FormatKind, DecodedFile.DecodedFile> =
            HashMap.fromIterable(Array.zip(claimed, placedFiles))
          // Read slots through FormatResults, as `redecodeFormat` does, so each is its own `Result<K>`.
          const results: FormatResults = batch
          return Effect.map(
            collectFormats(
              <K extends FormatKind>(kind: K): Effect.Effect<FormatDecode.Result<K>> =>
                Effect.succeed(
                  Option.match(HashMap.get(resolvedByKind, kind), {
                    onNone: () => results[kind],
                    onSome: (decoded) => ({ ...results[kind], decoded }),
                  })
                ),
              batch.unrecognizedFiles
            ),
            (resolvedFormats): ResolvedBatch => ({ ...resolvedFormats, linked, links })
          )
        }
      ),
  })

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
  const linkChoices = HashMap.union(defaults, chosen)
  return resolveMentions(batch, linkChoices).pipe(
    Effect.map((resolved) => ({ batch: resolved, linkChoices })),
    Effect.catchTag('InvalidLinkChoice', (failure) => {
      if (HashMap.has(chosen, failure.referentKey)) {
        return resolveMentionsWithFallback(
          batch,
          defaults,
          HashMap.remove(chosen, failure.referentKey)
        )
      }
      if (HashMap.has(defaults, failure.referentKey)) {
        return resolveMentionsWithFallback(
          batch,
          HashMap.remove(defaults, failure.referentKey),
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
