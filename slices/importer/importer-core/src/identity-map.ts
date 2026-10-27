import {
  type DecodedFile,
  type FormatDecode,
  IdentityMap,
  type LinkChoice,
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

export { applyIdentityMap, discoverReferents }
