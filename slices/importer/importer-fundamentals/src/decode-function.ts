/**
 * The batch decode every format binding exposes — files and settings in, one
 * `FormatDecode.Decoded` out, never failing — and the one constructor that
 * builds it.
 *
 * @remarks
 * {@link make} groups a batch into file sets, decodes each set, namespaces its
 * review keys, and folds a set that fails into `unreadableFiles` rows. It
 * returns each set's decode apart, with its members, because
 * `importer-core`'s import stage (`importDecoded`) mints each set's source
 * files and makes its records the device's own.
 *
 * What differs between formats is {@link Config.groupBy} — which files are
 * decoded together. Left out, every file is its own set; a format whose files
 * must be read together (DICOM's studies) says which key they share and gets
 * the same key-namespacing and failure folding around it. A format that needs
 * a parse to state that key parses twice — once in `groupBy` for the key, once
 * in `decodeFileSet` for the contents — which is a deliberate trade of a
 * little work for a constructor with no parsed-value passthrough in it.
 *
 * @packageDocumentation
 */

import type { ParseResult } from 'effect'
import { Array as Arr, Effect, Either, Function } from 'effect'

import * as DecodedFileSet from './decoded-file-set.ts'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import type * as PickedFile from './picked-file.ts'

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing.
 *
 * @typeParam R - What the format's decode requires of its caller — `never`
 *   for a format that reads its bytes itself, a service such as
 *   `positioned-text`'s `PositionedTextExtractor` for one that needs a
 *   platform library to read them
 */
type Type<in TSettings, TFormat extends string, out R = never> = (
  files: readonly PickedFile.Type[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Decoded<TFormat>, never, R>

/** What {@link make} needs of a format, `R` being what its `decodeFileSet` requires. */
interface Config<TFormat extends string, TSettings, R = never> {
  readonly format: TFormat
  /**
   * Which files are decoded together, as the key they share.
   *
   * @remarks
   * Left out, each file is its own set, keyed by its own id. A `Left` keeps
   * the file out of every set and reports it as an `unreadableFiles` row —
   * a file that states no key belongs to no set, and folding it into a
   * neighbour's would hide which file failed.
   */
  readonly groupBy?:
    | ((file: PickedFile.Type) => Either.Either<string, ParseResult.ParseError>)
    | undefined
  /**
   * One set's decode, every resource in it already adopted: each reaches the
   * import stage as an `Adopted` record.
   */
  readonly decodeFileSet: (
    members: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
    settings: TSettings
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError, R>
}

/** Decode one set, its review keys namespaced by its first member in pick order. */
const decodeSet = <TSettings, R>(
  members: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  settings: TSettings,
  config: Config<string, TSettings, R>
): Effect.Effect<DecodedFileSet.Type, ParseResult.ParseError, R> =>
  Effect.map(config.decodeFileSet(members, settings), (decoded) =>
    DecodedFileSet.ofAdopted(
      members,
      DecodedFile.namespaceKeys(decoded, FormatDecode.keyPrefix(members[0]))
    )
  )

/** What the sets a batch groups into, and the picks that reached none of them. */
interface Grouped {
  readonly fileSets: readonly Arr.NonEmptyReadonlyArray<PickedFile.Type>[]
  readonly unreadable: readonly {
    readonly file: PickedFile.Type
    readonly error: ParseResult.ParseError
  }[]
}

/**
 * Group a batch by the key its format states, keeping the picks that stated
 * none.
 *
 * @remarks
 * The sets come out ordered by the pick that opened each — the order the
 * reviewer picked the files in, which is also the order their members keep
 * within a set. A `Map` rather than `Array.groupBy`'s record, which hoists
 * integer-like keys ahead of the rest in numeric order.
 */
const groupFiles = (
  files: readonly PickedFile.Type[],
  groupBy: (file: PickedFile.Type) => Either.Either<string, ParseResult.ParseError>
): Grouped => {
  const [unreadable, keyed] = Arr.partitionMap(files, (file) =>
    Either.mapBoth(groupBy(file), {
      onLeft: (error) => ({ file, error }),
      onRight: (key) => ({ file, key }),
    })
  )
  const byKey = new Map<string, Arr.NonEmptyArray<PickedFile.Type>>()
  for (const { file, key } of keyed) {
    const fileSet = byKey.get(key)
    if (fileSet === undefined) byKey.set(key, [file])
    else fileSet.push(file)
  }
  return { fileSets: [...byKey.values()], unreadable }
}

/**
 * Build a format's batch `decode` from how its files group and how one group
 * reads.
 *
 * @param config - The format's tag, its `decodeFileSet`, and optionally its
 *   `groupBy`, for a format whose files are read together
 * @returns The format's batch decode: never failing, requiring what
 *   `decodeFileSet` requires
 *
 * @remarks
 * Sets are decoded concurrently and each is independent: one that rejects
 * yields an `unreadableFiles` row per pick in it while the rest stay
 * reviewable.
 */
const make = <TFormat extends string, TSettings, R = never>(
  config: Config<TFormat, TSettings, R>
): Type<TSettings, TFormat, R> => {
  const groupBy = config.groupBy ?? ((file: PickedFile.Type) => Either.right(file.id))
  return (files, settings): Effect.Effect<FormatDecode.Decoded<TFormat>, never, R> => {
    const grouped = groupFiles(files, groupBy)
    return Effect.forEach(
      grouped.fileSets,
      (members) =>
        decodeSet(members, settings, config).pipe(
          Effect.mapError((error) =>
            // A set is read as a whole, so a set that rejects rejects every pick
            // in it — each with its own row, naming the file the reviewer picked.
            members.map((file) => FormatDecode.unreadableFile(config.format, file, error))
          ),
          Effect.either
        ),
      { concurrency: 'unbounded' }
    ).pipe(
      Effect.map((results): FormatDecode.Decoded<TFormat> => {
        const [rejected, fileSets] = Arr.partitionMap(results, Function.identity)
        return {
          format: config.format,
          files,
          fileSets,
          // The picks no set claimed come first, in pick order, ahead of the
          // sets that rejected.
          unreadableFiles: [
            ...grouped.unreadable.map((one) =>
              FormatDecode.unreadableFile(config.format, one.file, one.error)
            ),
            ...rejected.flat(),
          ],
        }
      })
    )
  }
}

export { make }
export type { Config, Type }
