/**
 * The batch decode every format binding exposes — files and settings in, one
 * `FormatDecode.Result` out, never failing — and the one constructor that
 * builds it.
 *
 * @remarks
 * {@link make} is where source file handling lives: it mints a
 * `DocumentReference` for every picked file, lists the source files among the
 * reviewed sections, stamps `meta.source` on everything the decode produced,
 * and provides the format's `PickedFile.Format` internally, so what a binding
 * writes is a literal and what a consumer holds requires nothing.
 *
 * What differs between formats is {@link Config.groupBy} — which files are
 * decoded together. Left out, every file is its own set; a format whose files
 * must be read together (DICOM's studies) says which key they share and gets
 * the same minting, key-namespacing and failure folding around it. A format
 * that needs a parse to state that key parses twice — once in `groupBy` for
 * the key, once in `decodeFileSet` for the contents — which is a deliberate
 * trade of a little work for a constructor with no parsed-value passthrough in
 * it.
 *
 * @packageDocumentation
 */

import type { ParseResult } from 'effect'
import { Array as Arr, Effect, Either, Schema } from 'effect'
import type { DocumentReference } from 'fhir-r4/resources'

import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as MetaSource from './meta-source.ts'
import * as PickedFile from './picked-file.ts'

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing and requiring nothing.
 */
type Type<in TSettings, TFormat extends string> = (
  files: readonly PickedFile.Type[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Result<TFormat>, never>

/**
 * One file of a set as {@link Config.decodeFileSet} reads it: the pick, plus
 * the source file minted for it.
 */
type WithSourceFile = PickedFile.Type & { readonly sourceFile: DocumentReference.Type }

/** What {@link make} needs of a format. */
interface Config<TFormat extends string, TSettings> {
  readonly format: TFormat
  /** The format's source file constants — {@link make} provides them internally. */
  readonly sourceFileFormat: PickedFile.FormatValue
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
  readonly decodeFileSet: (
    members: Arr.NonEmptyReadonlyArray<WithSourceFile>,
    settings: TSettings
  ) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>
  /**
   * What this set's source files are listed and stamped as, read off its decode.
   *
   * @remarks
   * Runs after the decode, once per member, with that member's minted source file
   * and the set's whole decode — so a format names the subject and the related
   * resources off what it already extracted. **The source file's `id` must not
   * change**: the row that is listed and the reference every resource's
   * `meta.source` names are both read off the result. Left out, a source file is
   * stored exactly as minted — which keeps an engineering artifact out of
   * `Patient/$everything`.
   */
  readonly linkSourceFile?:
    | ((minted: DocumentReference.Type, decoded: DecodedFile.DecodedFile) => DocumentReference.Type)
    | undefined
}

/** The section title one picked file's source file is reviewed under. */
const SOURCE_FILE_SECTION_TITLE = 'Source file'

/** The section title several source files read together are reviewed under. */
const SOURCE_FILES_SECTION_TITLE = 'Source files'

/** The review key of a source file row, stable across a settings re-decode. */
const sourceFileKey = (file: PickedFile.Type): string =>
  `${FormatDecode.keyPrefix(file)}source-file/${file.fileName}`

const mintSourceFile = Schema.encode(PickedFile.FromDocumentReference)

/** A source file stored exactly as minted — what a format that states no `source file` gets. */
const asMinted = (minted: DocumentReference.Type): DocumentReference.Type => minted

/**
 * The member whose source file stamps `meta.source` on the set's resources: the
 * one with the lexicographically smallest source file id.
 *
 * @remarks
 * A source file's id is a content hash of the file's bytes and name, so the
 * smallest of them is a fact about the set and not about the order it was
 * picked in — which is what makes the same study, picked any way round,
 * synthesize identical resources. Review keys need only survive a settings
 * re-decode, so they are namespaced by the set's first member in pick order
 * instead.
 */
const representativeOf = (
  withSourceFiles: Arr.NonEmptyReadonlyArray<WithSourceFile>
): WithSourceFile =>
  withSourceFiles.reduce((smallest, one) =>
    sourceFileId(one) < sourceFileId(smallest) ? one : smallest
  )

/**
 * A source file's logical id. The mint always states one; `DocumentReference.id`
 * is nullable on the resource, and a source file missing it sorts first and
 * stamps a reference no resource resolves — which is what a mint that lost its
 * id should look like, rather than a crash.
 */
const sourceFileId = (one: WithSourceFile): string => one.sourceFile.id ?? ''

/**
 * Decode one set: mint a source file per pick, decode them together, let the
 * format finish each source file off the decode, and lead with the source files it is
 * about to store.
 */
const decodeSet = <TSettings>(
  members: Arr.NonEmptyReadonlyArray<PickedFile.Type>,
  settings: TSettings,
  config: Config<string, TSettings>
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError, PickedFile.Format> =>
  Effect.gen(function* () {
    const withSourceFiles = yield* Effect.forEach(
      members,
      (file): Effect.Effect<WithSourceFile, ParseResult.ParseError, PickedFile.Format> =>
        Effect.map(mintSourceFile(file), (sourceFile) => ({ ...file, sourceFile })),
      { concurrency: 'unbounded' }
    )

    const decoded = yield* config.decodeFileSet(withSourceFiles, settings)

    const finish = config.linkSourceFile ?? asMinted
    const finished: Arr.NonEmptyReadonlyArray<WithSourceFile> = Arr.map(withSourceFiles, (one) => ({
      ...one,
      sourceFile: finish(one.sourceFile, decoded),
    }))

    const stamped = MetaSource.stampDecoded(
      DecodedFile.namespaceKeys(decoded, FormatDecode.keyPrefix(members[0])),
      MetaSource.makeReference(sourceFileId(representativeOf(finished)))
    )

    const rows = finished.map((one): DecodedFile.Resource => ({
      key: sourceFileKey(one),
      title: one.fileName,
      resource: one.sourceFile,
    }))

    // Their own section ahead of what was read out of them, so the reviewer
    // sees what is about to be stored before what it yielded.
    const title = rows.length === 1 ? SOURCE_FILE_SECTION_TITLE : SOURCE_FILES_SECTION_TITLE
    return { ...stamped, sections: [{ title, resources: rows }, ...stamped.sections] }
  })

/** The `unreadableFiles` row one pick is reported as. */
const unreadableRow = (
  format: string,
  file: PickedFile.Type,
  error: ParseResult.ParseError
): FormatDecode.UnreadableFile => ({
  id: FormatDecode.makeFileId(format, file),
  title: file.fileName,
  pickedFile: file,
  error,
})

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
 * `Array.groupBy` keys are insertion-ordered, so the sets come out ordered by
 * the pick that opened each — the order the reviewer picked the files in, which
 * is also the order their members keep within a set.
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
  const fileSets = Object.values(Arr.groupBy(keyed, (one) => one.key)).map((set) =>
    Arr.map(set, (one) => one.file)
  )
  return { fileSets, unreadable }
}

/**
 * Build a format's batch `decode` from how its files group and how one group
 * reads.
 *
 * @param config - The format's tag, its source file constants, its
 *   `decodeFileSet`, and — for a format whose files are read together — its
 *   `groupBy` and its `source file`
 * @returns The format's batch decode: never failing, requiring nothing
 *
 * @remarks
 * Sets are decoded concurrently and each is independent: one that rejects
 * yields an `unreadableFiles` row per pick in it while the rest stay
 * reviewable. Within a set the source files are minted concurrently too, but they
 * are finished after the decode, because {@link Config.sourceFile} reads it.
 */
const make = <TFormat extends string, TSettings>(
  config: Config<TFormat, TSettings>
): Type<TSettings, TFormat> => {
  const groupBy = config.groupBy ?? ((file: PickedFile.Type) => Either.right(file.id))
  return (files, settings): Effect.Effect<FormatDecode.Result<TFormat>, never> => {
    const grouped = groupFiles(files, groupBy)
    const decoded = Effect.forEach(
      grouped.fileSets,
      (
        members
      ): Effect.Effect<
        Either.Either<DecodedFile.DecodedFile, readonly FormatDecode.UnreadableFile[]>,
        never,
        PickedFile.Format
      > =>
        decodeSet(members, settings, config).pipe(
          Effect.map(Either.right),
          Effect.catchAll((error) =>
            // A set is read as a whole, so a set that rejects rejects every pick
            // in it — each with its own row, naming the file the reviewer picked.
            Effect.succeed(
              Either.left(members.map((file) => unreadableRow(config.format, file, error)))
            )
          )
        ),
      { concurrency: 'unbounded' }
    ).pipe(
      Effect.map((results): FormatDecode.Result<TFormat> => {
        const sections: DecodedFile.Section[] = []
        const notes: string[] = []
        // The picks no set claimed come first, in pick order, ahead of the sets
        // that rejected.
        const unreadableFiles: FormatDecode.UnreadableFile[] = grouped.unreadable.map((one) =>
          unreadableRow(config.format, one.file, one.error)
        )
        for (const result of results) {
          Either.match(result, {
            onLeft: (rejected) => unreadableFiles.push(...rejected),
            onRight: (one) => {
              sections.push(...one.sections)
              notes.push(...one.notes)
            },
          })
        }
        return {
          id: FormatDecode.makeId(config.format, files),
          title: files.map((file) => file.fileName).join(', '),
          files,
          format: config.format,
          decoded: { sections, notes },
          unreadableFiles,
        }
      })
    )
    return Effect.provideService(decoded, PickedFile.Format, config.sourceFileFormat)
  }
}

export { SOURCE_FILE_SECTION_TITLE, SOURCE_FILES_SECTION_TITLE, make }
export type { WithSourceFile, Config, Type }
