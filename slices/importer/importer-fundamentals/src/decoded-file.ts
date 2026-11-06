/**
 * One file set's records the device's own: its rows in sections, each record
 * with an id to be written under, beside the set's notes.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

import type * as Row from './row.ts'
import * as Sectioned from './sectioned.ts'

/** A file set's rows, each record with an id to be written under, and its notes. */
interface DecodedFile extends Sectioned.Type<Row.Type<FhirResourceWithId>> {
  readonly notes: readonly string[]
}

/** No sections and no notes: a format with no claimed files. */
const empty: DecodedFile = { sections: [], notes: [] }

/** Every file's sections, in order ({@link Sectioned.combineAll}), and every file's notes. */
const combineAll = (files: readonly DecodedFile[]): DecodedFile => ({
  sections: Sectioned.combineAll(files).sections,
  notes: files.flatMap((file) => file.notes),
})

export { combineAll, empty }
export type { DecodedFile }
