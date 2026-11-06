/**
 * One file set's records the device's own: its rows in sections, each record
 * with an id to be written under, beside the set's notes.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

import type * as Reviewable from './reviewable.ts'
import * as SectionedList from './sectioned-list.ts'

/**
 * A decoded file's row: a record's {@link Reviewable.Type}, and the record it
 * will write, with an id to be written under.
 */
interface Row {
  readonly reviewable: Reviewable.Type
  readonly resource: FhirResourceWithId
}

/** A file set's rows, each record with an id to be written under, in sections, beside its notes. */
interface DecodedFile {
  readonly sectionedList: SectionedList.Type<Row>
  readonly notes: readonly string[]
}

/** No rows and no notes: a format with no claimed files. */
const empty: DecodedFile = { sectionedList: SectionedList.empty(), notes: [] }

/** Every file's sections, in order ({@link SectionedList.concatenateAll}), and every file's notes. */
const concatenateAll = (files: readonly DecodedFile[]): DecodedFile => ({
  sectionedList: SectionedList.concatenateAll(files.map((file) => file.sectionedList)),
  notes: files.flatMap((file) => file.notes),
})

export { concatenateAll, empty }
export type { DecodedFile, Row }
