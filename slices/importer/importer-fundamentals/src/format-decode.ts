/**
 * One format's decode result, and the identity derivations every id and review
 * key in it is built from.
 *
 * @remarks
 * All of them are built on a picked file's `id` — minted once, over the whole
 * batch in the order the files were picked, by `importer-core`'s `readBatch`.
 * Position takes part in it because picking two files that share a name is
 * ordinary (two `report.pdf`s out of two folders) and a name alone would
 * collide; and a settings re-decode hands the same files back, so everything
 * keyed by an id survives one.
 *
 * {@link keyPrefix} is the one that carries weight beyond uniqueness. A
 * `decodeFileSet` keys resources within *one* set — DICOM's fixed `patient`,
 * HAR's per-archive `har-entry-<index>` — because that is all it can see, while
 * the batch merges every claimed file's sections into one review whose
 * selection, server-diff verdicts and write plan are keyed by `(format, key)`.
 * Prefixing by the set's first picked file is what keeps the merged keys
 * distinct, so unticking one file's row cannot drop another's resource.
 *
 * @packageDocumentation
 */

import { type ParseResult } from 'effect'
import type * as DecodedFileSet from './decoded-file-set.ts'
import type * as FileImporter from './file-importer.ts'
import type * as PickedFile from './picked-file.ts'

/** The id of one format's files — deterministic in its files and their order. */
const makeId = (format: string, files: readonly PickedFile.Type[]): string =>
  `${format}/${files.map((file) => file.id).join(',')}`

/** The title one format's files are reported under: their names, in pick order. */
const titleOf = (files: readonly PickedFile.Type[]): string =>
  files.map((file) => file.fileName).join(', ')

/** The id of one file within its format's batch — an {@link UnreadableFile} row's, and an unrecognized picked file's. */
const makeFileId = (format: string, file: PickedFile.Type): string => `${format}/${file.id}`

/** The namespace every review key decoded out of one file set carries — see the module remarks. */
const keyPrefix = (file: PickedFile.Type): string => `${file.id}/`

/**
 * One format's decode, file set by file set, as its `decode` returns it:
 * `importer-core`'s import stage (`importDecoded`) makes it the format's
 * review group.
 */
interface Decoded<TFormat extends string> {
  readonly format: TFormat
  readonly files: readonly PickedFile.Type[]
  readonly fileSets: readonly DecodedFileSet.Type[]
  readonly unreadableFiles: readonly UnreadableFile[]
}

/**
 * One picked file that yielded nothing reviewable, and why: its decode
 * rejected it (`ParseError`), or a record read out of its set named a file no
 * picked file identifies as (`FileImporter.SourceFileNotFound`).
 */
interface UnreadableFile {
  readonly id: string
  readonly title: string
  readonly pickedFile: PickedFile.Type
  readonly error: ParseResult.ParseError | FileImporter.SourceFileNotFound
}

/** The {@link UnreadableFile} row one picked file of `format` is reported as. */
const makeUnreadableFile = (
  format: string,
  file: PickedFile.Type,
  error: UnreadableFile['error']
): UnreadableFile => ({
  id: makeFileId(format, file),
  title: file.fileName,
  pickedFile: file,
  error,
})

export { keyPrefix, makeFileId, makeId, makeUnreadableFile, titleOf }
export type { Decoded, UnreadableFile }
