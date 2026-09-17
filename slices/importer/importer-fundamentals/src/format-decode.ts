import { type ParseResult } from 'effect'
import type * as DecodedFile from './decoded-file.ts'
import { type PickedFile } from './picked-file.ts'

/**
 * One file's slot within the batch its format claimed: its position first,
 * then its name.
 *
 * @remarks
 * The position is what makes the slot unique — a pick of two files that
 * happen to share a name is ordinary (two `report.pdf`s out of two folders),
 * and a slot built from the name alone would let them collide on the ids and
 * review keys derived from it. The position is stable across a settings
 * re-decode because a format re-decode hands the same `files` array back,
 * so everything keyed by a slot survives one.
 */
const fileSlot = (index: number, file: PickedFile): string => `${index}:${file.fileName}`

/** The id of one format's whole decode result — deterministic in its files and their order. */
const makeId = (format: string, files: readonly PickedFile[]): string =>
  `${format}/${files.map((file, index) => fileSlot(index, file)).join(',')}`

/**
 * The id of one file within its format's batch — what an
 * {@link UnreadableFile} row and an unrecognized pick are identified by, and
 * what a React key over either can rely on being distinct.
 */
const makeFileId = (format: string, index: number, file: PickedFile): string =>
  `${format}/${fileSlot(index, file)}`

/**
 * The namespace every review key decoded out of one file carries.
 *
 * @remarks
 * A format's `DecodeOne` keys its resources within *one* file — DICOM's
 * fixed `patient` / `service-request` / `imaging-study`, HAR's
 * `har-entry-<index>` counting from zero per archive — because that is all a
 * per-file decode can see. The batch merges every claimed file's sections
 * into one format-wide review, while the selection, the server-diff verdicts
 * and the write plan are all keyed by `(format, key)`. Prefixing each file's
 * keys with its slot is what keeps those keys distinct across the merge, so
 * unticking one file's row cannot drop another file's resource.
 */
const keyPrefix = (index: number, file: PickedFile): string => `${fileSlot(index, file)}/`

interface Result<TFormat extends string> {
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile[]
  readonly format: TFormat
  readonly decoded: DecodedFile.DecodedFile
  readonly unreadableFiles: readonly UnreadableFile[]
}

interface UnreadableFile {
  readonly id: string
  readonly title: string
  readonly pickedFile: PickedFile
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
