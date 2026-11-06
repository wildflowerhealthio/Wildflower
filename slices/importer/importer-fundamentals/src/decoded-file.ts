/**
 * One file set's records the device's own: its rows in sections, each record
 * with an id to be written under, beside the set's notes.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

import type * as Row from './row.ts'
import * as SectionedList from './sectioned-list.ts'

/** A file set's rows, each record with an id to be written under, in sections, beside its notes. */
interface DecodedFile {
  readonly rows: SectionedList.Type<Row.Type<FhirResourceWithId>>
  readonly notes: readonly string[]
}

/** No rows and no notes: a format with no claimed files. */
const empty: DecodedFile = { rows: SectionedList.empty(), notes: [] }

/** Every file's sections, in order ({@link SectionedList.concatenateAll}), and every file's notes. */
const concatenateAll = (files: readonly DecodedFile[]): DecodedFile => ({
  rows: SectionedList.concatenateAll(files.map((file) => file.rows)),
  notes: files.flatMap((file) => file.notes),
})

export { concatenateAll, empty }
export type { DecodedFile }
