/**
 * One format's decode result, and the identity derivations every id and review
 * key in it is built from.
 *
 * @remarks
 * All of them are built on a picked file's `id` — minted once, over the whole
 * batch in pick order, by `importer-core`'s `readBatch`. Position takes part in
 * it because picking two files that share a name is ordinary (two `report.pdf`s
 * out of two folders) and a name alone would collide; and a settings re-decode
 * hands the same files back, so everything keyed by an id survives one.
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
import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'

/** The id of one format's whole decode result — deterministic in its files and their order. */
const makeId = (format: string, files: readonly PickedFile.Type[]): string =>
  `${format}/${files.map((file) => file.id).join(',')}`

/** The id of one file within its format's batch — an {@link UnreadableFile} row's, and an unrecognized pick's. */
const makeFileId = (format: string, file: PickedFile.Type): string => `${format}/${file.id}`

/** The namespace every review key decoded out of one file set carries — see the module remarks. */
const keyPrefix = (file: PickedFile.Type): string => `${file.id}/`

interface Result<TFormat extends string> {
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile.Type[]
  readonly format: TFormat
  readonly decoded: DecodedFile.DecodedFile
  readonly unreadableFiles: readonly UnreadableFile[]
}

interface UnreadableFile {
  readonly id: string
  readonly title: string
  readonly pickedFile: PickedFile.Type
  readonly error: ParseResult.ParseError
}

/** A format with no claimed files — the seed for unclaimed format slots. */
const emptyResult = <K extends string>(kind: K): Result<K> => ({
  id: makeId(kind, []),
  title: '',
  files: [],
  format: kind,
  decoded: { sections: [], notes: [] },
  unreadableFiles: [],
})

export { emptyResult, keyPrefix, makeFileId, makeId }
export type { Result, UnreadableFile }
