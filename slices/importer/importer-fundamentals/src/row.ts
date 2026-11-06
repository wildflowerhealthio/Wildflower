/**
 * One reviewed row of an import: a record under its review key and title,
 * and where it came from.
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
 * One reviewed record: its review key, its title, where it came from, and
 * the record, `R` being what the record is at its stage of the import (an id
 * to be written under, once adopted).
 */
interface Type<R> {
  readonly key: string
  readonly title: string
  readonly origin: Origin
  readonly resource: R
}

export type { Origin, Type }
