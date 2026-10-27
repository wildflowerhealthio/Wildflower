import {
  type DecodedFile,
  type FormatDecode,
  IdentityMap,
  type LinkChoice,
  LinkPlan,
  type LinkTarget,
  Referent,
  type ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Effect, HashMap, Option } from 'effect'

import {
  type BatchDecodeResult,
  claimedFormats,
  collectFormats,
  type FormatResults,
} from './read-batch.ts'
import type { FormatKind } from './registry.ts'

/**
 * The identity map lifted over a batch: one map for every format the batch
 * read, so the same person in a HAR and a PDF is one referent with one
 * choice. Service-free: the screen holds the choices and runs these on each
 * change.
 *
 * @packageDocumentation
 */

/**
 * Every referent the batch holds, once per identity across formats, in
 * format-then-review order, those with a resource first
 * (`Referent.discover`).
 *
 * @param batch - The batch's decode result
 * @returns The referents the reviewer makes a link choice for
 */
const discoverReferents = (
  batch: BatchDecodeResult
): Effect.Effect<readonly Referent.Type[], Referent.DuplicateReferent> =>
  Referent.discover(claimedFormats(batch).map((kind) => batch[kind].decoded))

/**
 * The batch with every claimed format's `decoded` placed on `linkChoices`:
 * the batch to review, diff and write.
 *
 * @param batch - The batch's decode result
 * @param linkChoices - The reviewer's link choices, by `Referent.key`
 * @returns The batch with each claimed format's decoded file placed, every
 *   other field as it was
 *
 * @remarks
 * Every claimed format is placed on one plan over the batch's referents
 * (`IdentityMap.apply`), so a mention in one format links to a referent
 * another holds. The Linked section is appended once, to the first claimed
 * format, so a stored person several formats only mention is written once.
 * Section titles and review keys are kept, so the selections survive. Fails
 * as `IdentityMap.apply` does.
 */
const applyIdentityMap = (
  batch: BatchDecodeResult,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<BatchDecodeResult, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Array.match(claimedFormats(batch), {
    onEmpty: () => Effect.succeed(batch),
    onNonEmpty: (claimed) =>
      Effect.flatMap(
        IdentityMap.apply(
          Array.map(claimed, (kind) => batch[kind].decoded),
          linkChoices
        ),
        (placedFiles) => {
          const placedByKind: HashMap.HashMap<FormatKind, DecodedFile.DecodedFile> =
            HashMap.fromIterable(Array.zip(claimed, placedFiles))
          // Read slots through FormatResults, as `redecodeFormat` does, so each is its own `Result<K>`.
          const results: FormatResults = batch
          return collectFormats(
            <K extends FormatKind>(kind: K): Effect.Effect<FormatDecode.Result<K>> =>
              Effect.succeed(
                Option.match(HashMap.get(placedByKind, kind), {
                  onNone: () => results[kind],
                  onSome: (decoded) => ({ ...results[kind], decoded }),
                })
              ),
            batch.unrecognizedFiles
          )
        }
      ),
  })

/** A batch placed on choices the stage can follow, with those choices and where each referent lands. */
interface PlacedOnFollowableChoices {
  readonly linkChoices: ReferentLinkChoices.Type
  readonly linkTargets: HashMap.HashMap<string, LinkTarget.Type>
  readonly batch: BatchDecodeResult
}

/**
 * `batch` placed on the reviewer's `chosen` choices over the searched
 * `defaults`, less every choice the stage cannot follow (a re-decode may have
 * changed a referent's kind, or removed the referent a choice linked to).
 *
 * @param batch - The batch's decode result
 * @param defaults - The searched default choices, by `Referent.key`
 * @param chosen - The reviewer's own choices, by `Referent.key`, over the defaults
 * @returns The choices followed, each referent's link target under them, and
 *   the placed batch
 *
 * @remarks
 * Each failure names the choice the stage could not follow. The reviewer's
 * own choice for that referent goes first, so the referent falls back to its
 * searched default; a default that cannot be followed either goes next, so
 * it falls back to its kind's default. A failure naming a referent with no
 * choice at all is a defect in the stage's defaults, so it dies rather than
 * loop.
 */
const placeBatchOnFollowableChoices = (
  batch: BatchDecodeResult,
  defaults: ReferentLinkChoices.Type,
  chosen: ReferentLinkChoices.Type
): Effect.Effect<PlacedOnFollowableChoices, Referent.DuplicateReferent> => {
  const linkChoices = HashMap.union(defaults, chosen)
  return Effect.all({
    batch: applyIdentityMap(batch, linkChoices),
    plan: LinkPlan.make(
      claimedFormats(batch).map((kind) => batch[kind].decoded),
      linkChoices
    ),
  }).pipe(
    Effect.map(({ batch: placedBatch, plan }) => ({
      linkChoices,
      linkTargets: HashMap.fromIterable(
        plan.links.map(({ referent, target }) => [Referent.key(referent), target] as const)
      ),
      batch: placedBatch,
    })),
    Effect.catchTag('InvalidLinkChoice', (failure) => {
      if (HashMap.has(chosen, failure.referentKey)) {
        return placeBatchOnFollowableChoices(
          batch,
          defaults,
          HashMap.remove(chosen, failure.referentKey)
        )
      }
      if (HashMap.has(defaults, failure.referentKey)) {
        return placeBatchOnFollowableChoices(
          batch,
          HashMap.remove(defaults, failure.referentKey),
          chosen
        )
      }
      return Effect.die(
        new Error(
          `a kind's default choice could not be followed: ${failure.reason} for ${failure.referentKey}`
        )
      )
    })
  )
}

export { applyIdentityMap, discoverReferents, placeBatchOnFollowableChoices }
