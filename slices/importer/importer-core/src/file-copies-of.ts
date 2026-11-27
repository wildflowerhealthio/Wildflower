/**
 * A format's decode read as copies of records: each file set's source files
 * and records as the import stage finishes them for the import plan, placed,
 * linked and stamped, with no reference between them resolved.
 *
 * @packageDocumentation
 */
import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DecodedFileSet,
  type FileImporter,
  FileSetOrigin,
  type FormatDecode,
  ImportedCopy,
  type PickedFile,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import {
  finishEachFileSet,
  type ImportingFormat,
  linkAndStamp,
  mintSourceFiles,
} from './import-decoded.ts'

/** The notes one file set's decode left, beside the file set (its `origin`). */
interface FileSetNotes {
  readonly origin: FileSetOrigin.Type
  readonly notes: Arr.NonEmptyReadonlyArray<string>
}

/**
 * What one format's decode brings to an import: its format, the picked
 * files it claimed, every copy of the file sets the import stage finished,
 * in plan order, the notes of each finished set that left any, and a row
 * per picked file it could not read.
 *
 * @typeParam TFormat - The format's tag, as its decode's
 *   `FormatDecode.Decoded` carries it
 *
 * @remarks
 * `files` are the picks the format's decode read (`FormatDecode.Decoded`'s
 * `files`), every one of them whether it was read or not, so the format can
 * be read again from them under other settings (`rereadFormatCopies`).
 */
interface FormatCopies<TFormat extends string> {
  readonly format: TFormat
  readonly files: readonly PickedFile.Type[]
  readonly copies: readonly ImportedCopy.Type[]
  readonly notes: readonly FileSetNotes[]
  readonly unreadableFiles: readonly FormatDecode.UnreadableFile[]
}

/** The copies and notes of one file set the import stage finished. */
interface FinishedFileSet {
  readonly copies: readonly ImportedCopy.Type[]
  readonly notes: Option.Option<FileSetNotes>
}

/**
 * One file set's copies: its source files first, as the import stage leads
 * with them, then its records in section order, the records they imply
 * last.
 *
 * @remarks
 * The import stage's own steps, but for one: its source files are minted,
 * its records placed (`DecodedFileSet.placedRecordsOf`, each under the id
 * its plan decided) and both linked and stamped as `importDecoded` links and
 * stamps them (`linkAndStamp`), but no reference between the set's records is
 * resolved. Where a reference lands is the reviewer's choice of the record
 * it names, so each copy names the set's other records as decoded.
 */
const fileSetCopiesOf = (
  importer: ImportingFormat,
  format: string,
  fileSet: DecodedFileSet.Type
): Effect.Effect<
  FinishedFileSet,
  ParseResult.ParseError | FileImporter.SourceFileNotFound,
  PickedFile.Format
> =>
  Effect.gen(function* () {
    const origin = FileSetOrigin.fromFileSet(format, fileSet)
    const sourceFiles = yield* mintSourceFiles(fileSet)
    const placed = yield* DecodedFileSet.placedRecordsOf(fileSet.sectionedList, randomResourceId)
    const { sourceFiles: linked, records } = yield* linkAndStamp(importer, sourceFiles, {
      sectionedList: DecodedFileSet.placedRowsOf(placed, FileSetOrigin.keyPrefixOf(origin)),
      notes: fileSet.notes,
    })
    return {
      copies: [
        ...linked.map((sourceFile) => ImportedCopy.fromSourceFile(origin, sourceFile)),
        ...SectionedList.rows(records.sectionedList).map((row) =>
          ImportedCopy.fromPlacedRow(origin, row)
        ),
      ],
      notes: Option.map(
        Option.liftPredicate(records.notes, Arr.isNonEmptyReadonlyArray),
        (notes): FileSetNotes => ({ origin, notes })
      ),
    }
  })

/**
 * Every copy one format's decode brings, file set by file set, in plan order.
 *
 * @param importer - The format's importer, whose source-file format and
 *   hooks the import stage runs
 * @param decoded - The format's decode, as its `decode` returned it
 * @returns The format's copies, never failing: as `importDecoded` does
 *   (`finishEachFileSet`), a set the import stage cannot finish (a source
 *   file that cannot be minted, an implied record its schema rejects, a
 *   record naming a file no picked file of the set identifies as) is an
 *   unreadable row per picked file of the set, after the rows the decode
 *   reported, while the other sets keep their copies and notes
 */
const fileCopiesOf = <TFormat extends string>(
  importer: ImportingFormat,
  decoded: FormatDecode.Decoded<TFormat>
): Effect.Effect<FormatCopies<TFormat>> =>
  Effect.map(
    finishEachFileSet(importer, decoded, (fileSet) =>
      fileSetCopiesOf(importer, decoded.format, fileSet)
    ),
    ({ finished, unreadableFiles }): FormatCopies<TFormat> => ({
      format: decoded.format,
      files: decoded.files,
      copies: finished.flatMap(({ copies }) => copies),
      notes: Arr.getSomes(finished.map(({ notes }) => notes)),
      unreadableFiles,
    })
  )

export { fileCopiesOf }
export type { FileSetNotes, FormatCopies }
