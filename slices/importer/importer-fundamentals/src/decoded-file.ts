/**
 * One file set's records the device's own: its rows in sections, each record
 * with an id to be written under, beside the set's notes.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

import type * as Row from './row.ts'
import * as SectionedList from './sectioned-list.ts'

/** A file set's rows, each record with an id to be written under, and its notes. */
interface DecodedFile extends SectionedList.Type<Row.Type<FhirResourceWithId>> {
  readonly notes: readonly string[]
}

/** No sections and no notes: a format with no claimed files. */
const empty: DecodedFile = { sections: [], notes: [] }

/** Every file's sections, in order ({@link SectionedList.concatenateAll}), and every file's notes. */
const concatenateAll = (files: readonly DecodedFile[]): DecodedFile => ({
  sections: SectionedList.concatenateAll(files).sections,
  notes: files.flatMap((file) => file.notes),
})

export { concatenateAll, empty }
export type { DecodedFile }
