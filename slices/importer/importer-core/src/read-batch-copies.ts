/**
 * A picked batch read into copies of records: each claimed format's decode
 * finished by the import stage for the import plan, with nothing planned.
 *
 * @packageDocumentation
 */
import type { ImportedCopy, PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { Effect } from 'effect'

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

/** What one claimed format read: its copies, its decode's notes and the files it could not read. */
interface FormatRead extends FormatCopies {
  readonly format: FormatKind
}

/** A picked batch read as copies: what each claimed format read, and the picks no format claimed. */
interface BatchCopies {
  /** What each claimed format read, in registry order. */
  readonly formats: readonly FormatRead[]
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
      ([format, files]) =>
        Effect.map(
          decodeFormat(registry, settings, format, files, fileCopiesOf),
          (copies): FormatRead => ({ format, ...copies })
        ),
      { concurrency: 'unbounded' }
    ),
    (formats): BatchCopies => ({
      formats,
      unrecognizedFiles: unrecognized.map(unrecognizedFileOf),
    })
  )
}

/** Every copy `batchCopies` holds, format by format in registry order: the import plan's order. */
const copiesOf = (batchCopies: BatchCopies): readonly ImportedCopy.Type[] =>
  batchCopies.formats.flatMap(({ copies }) => copies)

export { copiesOf, readBatchCopies }
export type { BatchCopies, FormatRead }
