/**
 * One format's decode result, and the identity derivations every id and review
 * key in it is built from.
 *
 * @remarks
 * All of them are built on {@link fileSlot} — a file's *position* in the batch,
 * then its name. Position, because picking two files that share a name is
 * ordinary (two `report.pdf`s out of two folders) and a name-only slot would
 * collide; and position is stable across a settings re-decode, which hands the
 * same `files` array back, so everything keyed by a slot survives one.
 *
 * {@link keyPrefix} is the one that carries weight beyond uniqueness. A
 * format's `DecodeOne` keys resources within *one* file — DICOM's fixed
 * `patient`, HAR's per-archive `har-entry-<index>` — because that is all a
 * per-file decode can see, while the batch merges every claimed file's
 * sections into one review whose selection, server-diff verdicts and write
 * plan are keyed by `(format, key)`. Prefixing by slot is what keeps the
 * merged keys distinct, so unticking one file's row cannot drop another's
 * resource.
 *
 * @packageDocumentation
 */

import { type ParseResult } from 'effect'
import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'

/** One file's slot within the batch its format claimed: its position, then its name. */
const fileSlot = (index: number, file: PickedFile.Type): string => `${index}:${file.fileName}`

/** The id of one format's whole decode result — deterministic in its files and their order. */
const makeId = (format: string, files: readonly PickedFile.Type[]): string =>
  `${format}/${files.map((file, index) => fileSlot(index, file)).join(',')}`

/** The id of one file within its format's batch — an {@link UnreadableFile} row's, and an unrecognized pick's. */
const makeFileId = (format: string, index: number, file: PickedFile.Type): string =>
  `${format}/${fileSlot(index, file)}`

/** The namespace every review key decoded out of one file carries — see the module remarks. */
const keyPrefix = (index: number, file: PickedFile.Type): string => `${fileSlot(index, file)}/`

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

export { emptyResult, fileSlot, keyPrefix, makeFileId, makeId }
export type { Result, UnreadableFile }
