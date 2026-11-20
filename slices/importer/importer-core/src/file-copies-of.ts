/**
 * A format's decode read as copies of records: each file set's source files
 * and its placed records, as the import plan reads them.
 *
 * @packageDocumentation
 */
import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DecodedFileSet,
  type FileCopy,
  FormatDecode,
  PickedFile,
  ResourcePlan,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import { type ImportingFormat, sourceFileKey, sourceFileOf } from './import-decoded.ts'

/** The copy of a placed record of the file set whose picked files are `pickedFiles`. */
const placedCopyOf = (
  format: string,
  pickedFiles: DecodedFileSet.Type['pickedFiles'],
  { record, plan, isImplied }: DecodedFileSet.PlacedRecord
): FileCopy.Type => {
  const reviewKey = `${FormatDecode.keyPrefix(pickedFiles[0].pickedFile)}${record.localKey}`
  return {
    format,
    pickedFiles: Arr.map(pickedFiles, ({ pickedFile }) => pickedFile),
    reviewKey,
    title: DecodedFileSet.writtenReferenceTitle(plan, reviewKey),
    isImplied,
    resource: record.resource,
    sourceUrl: record.sourceUrl,
    derivedId: ResourcePlan.match(plan, {
      Derived: ({ id }) => Option.some(id),
      Minted: () => Option.none(),
    }),
  }
}

/**
 * The copy of the source file one picked file of a set is stored as: the
 * source file the import stage mints, carrying what the file identified
 * itself as, detached, its content-derived id kept as its derived id.
 */
const sourceFileCopyOf = (
  format: string,
  pickedFiles: DecodedFileSet.Type['pickedFiles'],
  { pickedFile, identifiedAs }: DecodedFileSet.PickedFileIdentity
): Effect.Effect<FileCopy.Type, ParseResult.ParseError, PickedFile.Format> =>
  Effect.map(sourceFileOf(pickedFile), (sourceFile) => ({
    format,
    pickedFiles: Arr.map(pickedFiles, (picked) => picked.pickedFile),
    reviewKey: sourceFileKey(pickedFile),
    title: pickedFile.fileName,
    isImplied: false,
    resource: { ...sourceFile, id: null, masterIdentifier: Option.getOrNull(identifiedAs) },
    sourceUrl: Option.none(),
    derivedId: Option.some(sourceFile.id),
  }))

/**
 * One file set's copies: its source files first, as the import stage leads
 * with them, then its placed records (`DecodedFileSet.placedRecordsOf`) in
 * section order.
 *
 * @remarks
 * The ids `placedRecordsOf` mints for keyless records are not kept: a copy
 * holds its record detached.
 */
const fileSetCopiesOf = (
  format: string,
  fileSet: DecodedFileSet.Type
): Effect.Effect<readonly FileCopy.Type[], ParseResult.ParseError, PickedFile.Format> =>
  Effect.gen(function* () {
    const sourceFileCopies = yield* Effect.forEach(fileSet.pickedFiles, (picked) =>
      sourceFileCopyOf(format, fileSet.pickedFiles, picked)
    )
    const placed = yield* DecodedFileSet.placedRecordsOf(fileSet.sectionedList, randomResourceId)
    return [
      ...sourceFileCopies,
      ...SectionedList.rows(placed).map((placedRecord) =>
        placedCopyOf(format, fileSet.pickedFiles, placedRecord)
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
): Effect.Effect<readonly FileCopy.Type[], ParseResult.ParseError> =>
  Effect.forEach(decoded.fileSets, (fileSet) => fileSetCopiesOf(decoded.format, fileSet)).pipe(
    Effect.map(Arr.flatten),
    Effect.provideService(PickedFile.Format, importer.sourceFileFormat)
  )

export { fileCopiesOf }
