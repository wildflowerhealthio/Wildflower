import {
  DecodedFile,
  DecodedFileSet,
  type FileImporter,
  FormatDecode,
  MetaSource,
  PickedFile,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Function, Option, Order, type ParseResult, Schema } from 'effect'

/**
 * The import stage: one format's decode, file set by file set, made the
 * device's own. The one place a record is adopted, a source file is minted
 * and `meta.source` is stamped.
 *
 * @remarks
 * Per set, {@link importFileSet} mints a source file for every picked file
 * (`PickedFile.FromDocumentReference`'s encode, its `masterIdentifier` what the
 * picked file identified itself as), adopts its detached records
 * (`DecodedFileSet.adopt`: a keyed record under the id its key derives, a
 * keyless one under a minted id, each logical reference to a record of the set
 * resolved to a literal one, a dispense with no subject filed on its
 * prescription's), runs the format's `linkSourceFile` over every source file
 * and its `linkToSourceFiles` over every record, stamps every
 * record's `meta.source` with the set's representative source file, and leads
 * with the source files as the set's own section. Each set's records are keyed
 * as they are: nothing is de-duplicated across sets or files.
 *
 * @packageDocumentation
 */

/** What the import stage reads off a format's importer: its source-file constants and hooks. */
type ImportingFormat = Pick<
  FileImporter.Type<unknown, string, unknown>,
  'sourceFileFormat' | 'linkSourceFile' | 'linkToSourceFiles'
>

/** The section title one picked file's source file is reviewed under. */
const SOURCE_FILE_SECTION_TITLE = 'Source file'

/** The section title several source files read together are reviewed under. */
const SOURCE_FILES_SECTION_TITLE = 'Source files'

/** The review key of a source file row, stable across a settings re-decode. */
const sourceFileKey = (file: PickedFile.Type): string =>
  `${FormatDecode.keyPrefix(file)}source-file/${file.fileName}`

/** A picked file's source file, as `PickedFile.FromDocumentReference` stores it. */
const sourceFileOf = Schema.encode(PickedFile.FromDocumentReference)

/**
 * Import one file set: mint its picked files' source files, adopt its records,
 * let the format link each source file to the records and each record to the
 * source files, stamp, and lead with the source files it is about to store.
 *
 * @remarks
 * A source file carries what its picked file identified itself as
 * (`DecodedFileSet.PickedFileIdentity`) as its `masterIdentifier`, which is
 * what a format's `linkToSourceFiles` matches a record's own identifiers
 * against.
 *
 * `meta.source` names the set's representative: the picked file whose source
 * file id is lexicographically smallest. A source file's id is a content hash
 * of the file's bytes and name, so the smallest of them is a fact about the set
 * and not about the order it was picked in, which is what makes the same study,
 * picked any way round, import identical resources.
 */
const importFileSet = (
  importer: ImportingFormat,
  fileSet: DecodedFileSet.Type
): Effect.Effect<
  DecodedFile.DecodedFile,
  ParseResult.ParseError | FileImporter.SourceFileNotFound,
  PickedFile.Format
> =>
  Effect.gen(function* () {
    const sourceFiles = yield* Effect.all(
      Arr.map(fileSet.pickedFiles, ({ pickedFile, identifiedAs }) =>
        Effect.map(sourceFileOf(pickedFile), (sourceFile) => ({
          pickedFile,
          sourceFile: { ...sourceFile, masterIdentifier: Option.getOrNull(identifiedAs) },
        }))
      ),
      { concurrency: 'unbounded' }
    )
    const adopted = yield* DecodedFileSet.adopt(fileSet)

    const linkSourceFile = importer.linkSourceFile ?? Function.identity
    const linked = Arr.map(sourceFiles, ({ pickedFile, sourceFile }) => ({
      pickedFile,
      sourceFile: linkSourceFile(sourceFile, adopted),
    }))

    const linkToSourceFiles = importer.linkToSourceFiles ?? Effect.succeed
    const linkedToSourceFiles = yield* SectionedList.forEach(adopted.rows, (row) =>
      Effect.map(linkToSourceFiles(row.resource, linked), (resource) => ({ ...row, resource }))
    )
    const stamped = MetaSource.stampDecoded(
      { rows: linkedToSourceFiles, notes: adopted.notes },
      MetaSource.makeReference(
        Arr.min(
          Arr.map(linked, ({ sourceFile }) => sourceFile.id),
          Order.string
        )
      )
    )

    const sourceFileRows = linked.map(({ pickedFile, sourceFile }): DecodedFile.Row => ({
      reviewable: {
        key: sourceFileKey(pickedFile),
        title: pickedFile.fileName,
        origin: 'Decoded',
      },
      resource: sourceFile,
    }))
    // Their own section ahead of what was read out of them, so the reviewer
    // sees what is about to be stored before what it yielded.
    const title =
      sourceFileRows.length === 1 ? SOURCE_FILE_SECTION_TITLE : SOURCE_FILES_SECTION_TITLE
    return {
      ...stamped,
      rows: SectionedList.prepend(stamped.rows, Section.make(title, sourceFileRows)),
    }
  })

/**
 * Import one format's decode: every file set through {@link importFileSet},
 * merged into the one review the format's {@link FormatDecode.Result} holds.
 *
 * @param importer - The format's importer, whose source-file constants and
 *   hooks the import reads
 * @param decoded - The format's decode, as its `decode` returned it
 * @returns The imported result, never failing
 *
 * @remarks
 * Sets are imported concurrently and each is independent: one whose source file
 * cannot be built, or whose records name a file none of its picked files
 * identifies as (`FileImporter.SourceFileNotFound`), yields an
 * `unreadableFiles` row per picked file, after the
 * rows the decode already reported, while the rest stay reviewable. It provides
 * the `PickedFile.Format` service from the importer's `sourceFileFormat`
 * internally, so nothing it returns carries a requirement.
 */
const importDecoded = <TFormat extends string>(
  importer: ImportingFormat,
  decoded: FormatDecode.Decoded<TFormat>
): Effect.Effect<FormatDecode.Result<TFormat>> =>
  Effect.partition(
    decoded.fileSets,
    (fileSet) =>
      Effect.mapError(importFileSet(importer, fileSet), (error) =>
        fileSet.pickedFiles.map(({ pickedFile }) =>
          FormatDecode.makeUnreadableFile(decoded.format, pickedFile, error)
        )
      ),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map(([rejected, imported]): FormatDecode.Result<TFormat> => ({
      id: FormatDecode.makeId(decoded.format, decoded.files),
      title: decoded.files.map((file) => file.fileName).join(', '),
      files: decoded.files,
      format: decoded.format,
      decoded: DecodedFile.concatenateAll(imported),
      unreadableFiles: [...decoded.unreadableFiles, ...rejected.flat()],
    })),
    Effect.provideService(PickedFile.Format, importer.sourceFileFormat)
  )

export { importDecoded }
export type { ImportingFormat }
