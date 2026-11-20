/**
 * A format's decode read as copies of records: each file set's source files
 * and its placed records, as the import plan reads them.
 *
 * @packageDocumentation
 */
import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DecodedFileSet,
  FileSetOrigin,
  type FormatDecode,
  ImportedCopy,
  PickedFile,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, type ParseResult } from 'effect'

import { type ImportingFormat, sourceFileOf } from './import-decoded.ts'

/**
 * One file set's copies: its source files first, as the import stage leads
 * with them, then its placed records (`DecodedFileSet.placedRecordsOf`) in
 * section order.
 */
const fileSetCopiesOf = (
  format: string,
  fileSet: DecodedFileSet.Type
): Effect.Effect<readonly ImportedCopy.Type[], ParseResult.ParseError, PickedFile.Format> =>
  Effect.gen(function* () {
    const origin = FileSetOrigin.fromFileSet(format, fileSet)
    const sourceFileCopies = yield* Effect.forEach(fileSet.pickedFiles, (picked) =>
      Effect.map(sourceFileOf(picked.pickedFile), (sourceFile) =>
        ImportedCopy.fromSourceFile(origin, picked, sourceFile)
      )
    )
    const placed = yield* DecodedFileSet.placedRecordsOf(fileSet.sectionedList, randomResourceId)
    return [
      ...sourceFileCopies,
      ...SectionedList.rows(placed).map((placedRecord) =>
        ImportedCopy.fromPlacedRecord(origin, placedRecord)
      ),
    ]
  })

/**
 * Every copy one format's decode brings, file set by file set, in plan order.
 *
 * @param importer - The format's importer, whose source-file format its
 *   source files are minted under
 * @param decoded - The format's decode, as its `decode` returned it
 * @returns The copies; fails with the `ParseError` of the first file set
 *   whose source file cannot be minted or whose implied record its schema
 *   rejects
 */
const fileCopiesOf = (
  importer: Pick<ImportingFormat, 'sourceFileFormat'>,
  decoded: FormatDecode.Decoded<string>
): Effect.Effect<readonly ImportedCopy.Type[], ParseResult.ParseError> =>
  Effect.forEach(decoded.fileSets, (fileSet) => fileSetCopiesOf(decoded.format, fileSet)).pipe(
    Effect.map(Arr.flatten),
    Effect.provideService(PickedFile.Format, importer.sourceFileFormat)
  )

export { fileCopiesOf }
