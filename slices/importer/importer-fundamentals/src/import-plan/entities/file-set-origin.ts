/**
 * A file set's origin: the format that decoded one file set of an import and
 * the files it was read from, what every copy the set brings names it by.
 *
 * @packageDocumentation
 */
import { Array as Arr, Equivalence } from 'effect'

import type * as DecodedFileSet from '../../decoded-file-set.ts'
import * as FormatDecode from '../../format-decode.ts'
import type * as PickedFile from '../../picked-file.ts'

/** The format that decoded a file set, and the set's picked files in pick order. */
interface Type {
  readonly format: string
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>
}

/** The origin of the file set of `pickedFiles`, in pick order, decoded by `format`. */
const fromPickedFiles = (
  format: string,
  pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>
): Type => ({ format, pickedFiles })

/** The origin of `fileSet`, decoded by `format`. */
const fromFileSet = (format: string, fileSet: DecodedFileSet.Type): Type =>
  fromPickedFiles(
    format,
    Arr.map(fileSet.pickedFiles, ({ pickedFile }) => pickedFile)
  )

/**
 * Whether two origins are one file set: the same id over the format and every
 * picked file, in order (`FormatDecode.makeId`).
 */
const equivalence: Equivalence.Equivalence<Type> = Equivalence.mapInput(
  Equivalence.string,
  ({ format, pickedFiles }: Type) => FormatDecode.makeId(format, pickedFiles)
)

/**
 * What every review key of the set starts with: its first picked file's
 * prefix (`FormatDecode.keyPrefix`), as the import stage keys the set's rows.
 */
const keyPrefixOf = ({ pickedFiles }: Type): string =>
  FormatDecode.keyPrefix(Arr.headNonEmpty(pickedFiles))

export { equivalence, fromFileSet, fromPickedFiles, keyPrefixOf }
export type { Type }
