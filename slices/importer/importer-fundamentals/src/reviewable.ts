/**
 * A reviewable: the review's address for one record of an import, its title,
 * and where the record came from.
 *
 * @packageDocumentation
 */

/**
 * Where a reviewed record came from. `Decoded`: the record as a source holds
 * it, read out of a picked file (or, beside the files, a set's source file
 * or a stored record the batch links to). `Implied`: built by the import
 * from a reference to a record no file of its set holds
 * (`DecodedFileSet.adopt`), so it says only what that reference said of it.
 */
type Origin = 'Decoded' | 'Implied'

/**
 * The review's address for one record: the `key` the reviewer's ticks and
 * edits, the server diff and the link choices all index by, the `title` the
 * review shows it under, and where the record came from.
 */
interface Type {
  readonly key: string
  readonly title: string
  readonly origin: Origin
}

export type { Origin, Type }
