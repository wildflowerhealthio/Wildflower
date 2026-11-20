import {
  AdoptedFileSet,
  DecodedFileSet,
  type FileImporter,
  FormatDecode,
  MetaSource,
  PickedFile,
  type ReviewRow,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Function, Option, Order, type ParseResult, Schema } from 'effect'

import type * as ReviewGroup from './review-group.ts'

/**
 * The import stage: one format's decode, file set by file set, made the
 * device's own. The one place a record is adopted, a source file is minted
 * and `meta.source` is stamped.
 *
 * @remarks
 * Per set, {@link importFileSet} mints a source file for every picked file
 * (`PickedFile.FromDocumentReference`'s encode, its `masterIdentifier` what the
 * picked file identified itself as), adopts its records under review keys
 * prefixed by the set's first picked file (`DecodedFileSet.adopt`: a keyed record under the id its key derives, a
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

/** A picked file's source file, as `PickedFile.FromDocumentReference` stores it. */
const sourceFileOf = Schema.encode(PickedFile.FromDocumentReference)

/**
 * The source file each picked file of `fileSet` is stored as, minted
 * (`PickedFile.FromDocumentReference`'s encode), carrying what the picked
 * file identified itself as (`DecodedFileSet.PickedFileIdentity`) as its
 * `masterIdentifier`, which is what a format's `linkToSourceFiles` matches a
 * record's own identifiers against.
 */
const mintSourceFiles = (
  fileSet: DecodedFileSet.Type
): Effect.Effect<
  Arr.NonEmptyReadonlyArray<FileImporter.PickedSourceFile>,
  ParseResult.ParseError,
  PickedFile.Format
> =>
  Effect.all(
    Arr.map(fileSet.pickedFiles, ({ pickedFile, identifiedAs }) =>
      Effect.map(sourceFileOf(pickedFile), (sourceFile) => ({
        pickedFile,
        sourceFile: { ...sourceFile, masterIdentifier: Option.getOrNull(identifiedAs) },
      }))
    ),
    { concurrency: 'unbounded' }
  )

/** A set's source files, each linked to its records, beside its records, each linked to its source files and stamped. */
interface LinkedFileSet<TRow extends ReviewRow.Type> {
  readonly sourceFiles: Arr.NonEmptyReadonlyArray<FileImporter.PickedSourceFile>
  readonly records: AdoptedFileSet.Type<TRow>
}

/**
 * Link and stamp one set: the format's `linkSourceFile` over each of its
 * source files with its records, then its `linkToSourceFiles` over every
 * record with each picked file and its linked source file, then every
 * record's `meta.source` stamped with the set's representative.
 *
 * @param importer - The format's importer, whose hooks run
 * @param sourceFiles - The set's source files, as {@link mintSourceFiles} minted them
 * @param records - The set's records under the ids they are written under,
 *   their references resolved or as decoded, as the caller decides
 *
 * @remarks
 * `meta.source` names the set's representative: the picked file whose source
 * file id is lexicographically smallest. A source file's id is a content hash
 * of the file's bytes and name, so the smallest of them is a fact about the set
 * and not about the order it was picked in, which is what makes the same study,
 * picked any way round, import identical resources.
 */
const linkAndStamp = <TRow extends ReviewRow.Type>(
  importer: ImportingFormat,
  sourceFiles: Arr.NonEmptyReadonlyArray<FileImporter.PickedSourceFile>,
  records: AdoptedFileSet.Type<TRow>
): Effect.Effect<LinkedFileSet<TRow>, FileImporter.SourceFileNotFound> =>
  Effect.gen(function* () {
    const linkSourceFile = importer.linkSourceFile ?? Function.identity
    const linked = Arr.map(sourceFiles, ({ pickedFile, sourceFile }) => ({
      pickedFile,
      sourceFile: linkSourceFile(sourceFile, records),
    }))

    const linkToSourceFiles = importer.linkToSourceFiles ?? Effect.succeed
    const linkedToSourceFiles = yield* SectionedList.forEach(records.sectionedList, (row) =>
      Effect.map(linkToSourceFiles(row.resource, linked), (resource) => ({ ...row, resource }))
    )
    const stamped = MetaSource.stampAdopted(
      { sectionedList: linkedToSourceFiles, notes: records.notes },
      MetaSource.makeReference(
        Arr.min(
          Arr.map(linked, ({ sourceFile }) => sourceFile.id),
          Order.string
        )
      )
    )
    return { sourceFiles: linked, records: stamped }
  })

/**
 * Import one file set: mint its picked files' source files, adopt its records,
 * link and stamp ({@link linkAndStamp}), and lead with the source files it is
 * about to store.
 */
const importFileSet = (
  importer: ImportingFormat,
  fileSet: DecodedFileSet.Type
): Effect.Effect<
  AdoptedFileSet.Type,
  ParseResult.ParseError | FileImporter.SourceFileNotFound,
  PickedFile.Format
> =>
  Effect.gen(function* () {
    const sourceFiles = yield* mintSourceFiles(fileSet)
    const adopted = yield* DecodedFileSet.adopt(
      fileSet,
      FormatDecode.keyPrefix(fileSet.pickedFiles[0].pickedFile)
    )
    const { sourceFiles: linked, records: stamped } = yield* linkAndStamp(
      importer,
      sourceFiles,
      adopted
    )

    const sourceFileRows = linked.map(({ pickedFile, sourceFile }): ReviewRow.Type => ({
      reviewKey: FormatDecode.sourceFileKey(pickedFile),
      title: pickedFile.fileName,
      isImplied: false,
      resource: sourceFile,
    }))
    // Their own section ahead of what was read out of them, so the reviewer
    // sees what is about to be stored before what it yielded.
    const title =
      sourceFileRows.length === 1 ? SOURCE_FILE_SECTION_TITLE : SOURCE_FILES_SECTION_TITLE
    return {
      ...stamped,
      sectionedList: SectionedList.prepend(
        stamped.sectionedList,
        Section.make(title, sourceFileRows)
      ),
    }
  })

/**
 * Import one format's decode: every file set through {@link importFileSet},
 * merged into the format's one review group, which holds the picks the
 * format's decode read (`decoded.files`).
 *
 * @param importer - The format's importer, whose source-file constants and
 *   hooks the import reads
 * @param decoded - The format's decode, as its `decode` returned it
 * @returns The format's review group, never failing
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
): Effect.Effect<ReviewGroup.Type> =>
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
    Effect.map(([rejected, imported]): ReviewGroup.Type => ({
      ...AdoptedFileSet.concatenateAll(imported),
      unreadableFiles: [...decoded.unreadableFiles, ...rejected.flat()],
      files: decoded.files,
    })),
    Effect.provideService(PickedFile.Format, importer.sourceFileFormat)
  )

export { importDecoded, linkAndStamp, mintSourceFiles }
export type { ImportingFormat }
