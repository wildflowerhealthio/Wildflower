/**
 * A review row: one record of an import as the review addresses, titles and
 * writes it.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

/**
 * One record of an import, as the review shows it: the `reviewKey` the
 * reviewer's ticks and edits, the server diff and the link choices all index
 * by, the `title` the review shows it under, whether it is implied, and the
 * record it will write, with an id to be written under.
 *
 * @remarks
 * `isImplied`: the import built the record from a reference to a record no
 * file of its set holds (`DecodedFileSet.adopt`), so it says only what that
 * reference said of it. Every other row is a record as a source holds it:
 * read out of a picked file, or, beside the files, a set's source file or a
 * stored record the batch links to.
 */
interface Type {
  readonly reviewKey: string
  readonly title: string
  readonly isImplied: boolean
  readonly resource: FhirResourceWithId
}

export type { Type }
