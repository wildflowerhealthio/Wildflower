/**
 * A picked batch read into copies of records: each claimed format's decode
 * finished by the import stage for the import plan, with nothing planned.
 *
 * @packageDocumentation
 */
import type { ImportedCopy, PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option } from 'effect'

import { fileCopiesOf, type FormatCopies } from './file-copies-of.ts'
import {
  claimedEntries,
  claimPicks,
  decodeFormat,
  type ReadRegistry,
  type UnrecognizedFile,
  unrecognizedFileOf,
} from './read-batch.ts'
import type { FormatKind, FormatSettings } from './registry.ts'

/** A picked batch read as copies: what each claimed format read, and the picks no format claimed. */
interface BatchCopies {
  /** What each claimed format read, in registry order. */
  readonly formats: readonly FormatCopies<FormatKind>[]
  /** The picks no registered format claimed, in pick order. */
  readonly unrecognizedFiles: readonly UnrecognizedFile[]
}

/**
 * Read `picks` as copies of records: each format that claims a pick decodes
 * its picks under its settings, and the import stage finishes what it
 * decoded as copies (`fileCopiesOf`).
 *
 * @param registry - The registered formats' `detect`s and `decode`s
 * @param settings - Every format's settings
 * @param picks - The batch, in pick order
 * @returns What each claimed format read and the unrecognized picks,
 *   requiring what the registry's decodes require
 *
 * @remarks
 * Formats decode concurrently. A file set the import stage cannot import is
 * an unreadable row per picked file of its format, as `readBatch` reports
 * it, and the rest of the batch is read.
 */
const readBatchCopies = <R>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<BatchCopies, never, R> => {
  const { claimed, unrecognized } = claimPicks(registry, picks)
  return Effect.map(
    Effect.forEach(
      claimedEntries(claimed),
      ([format, files]) => decodeFormat(registry, settings, format, files, fileCopiesOf),
      { concurrency: 'unbounded' }
    ),
    (formats): BatchCopies => ({
      formats,
      unrecognizedFiles: unrecognized.map(unrecognizedFileOf),
    })
  )
}

/**
 * Read one format of `batchCopies` again under `settings`: its claimed
 * picked files decoded again and finished as copies, every other format's
 * entry passed back as it was.
 *
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's settings, the changed one included
 * @param format - The format to read again
 * @param batchCopies - The batch as read
 * @returns The batch with `format`'s entry replaced in its place, requiring
 *   what the registry's decodes require; the batch itself when `format`
 *   claimed nothing
 *
 * @remarks
 * Decoding is the cost (a PDF's text, a DICOM study's headers), so nothing
 * else is decoded. The format's entry holds the picked files it claimed
 * (`FormatCopies.files`), so the same picks are decoded, under the ids
 * `claimPicks` gave them, and each copy's review key and record key are
 * built on them as before.
 */
const rereadFormatCopies = <R>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  format: FormatKind,
  batchCopies: BatchCopies
): Effect.Effect<BatchCopies, never, R> =>
  Arr.findFirst(batchCopies.formats, (formatCopies) => formatCopies.format === format).pipe(
    Option.match({
      onNone: () => Effect.succeed(batchCopies),
      onSome: ({ files }) =>
        Effect.map(
          decodeFormat(registry, settings, format, files, fileCopiesOf),
          (reread): BatchCopies => ({
            ...batchCopies,
            formats: batchCopies.formats.map((formatCopies) =>
              formatCopies.format === format ? reread : formatCopies
            ),
          })
        ),
    })
  )

/** Every copy `batchCopies` holds, format by format in registry order: the import plan's order. */
const copiesOf = (batchCopies: BatchCopies): readonly ImportedCopy.Type[] =>
  batchCopies.formats.flatMap(({ copies }) => copies)

export { copiesOf, readBatchCopies, rereadFormatCopies }
export type { BatchCopies }
