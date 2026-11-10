/**
 * One file set's records made the device's own: the import stage's output for
 * one file set, its rows in sections beside its notes.
 *
 * @packageDocumentation
 */
import type * as ReviewRow from './review-row.ts'
import * as SectionedList from './sectioned-list.ts'

/**
 * One file set's rows, each record with an id to be written under, in
 * sections, beside its notes.
 */
interface Type {
  readonly sectionedList: SectionedList.Type<ReviewRow.Type>
  readonly notes: readonly string[]
}

/** Every set's sections, in order ({@link SectionedList.concatenateAll}), and every set's notes. */
const concatenateAll = (adoptedFileSets: readonly Type[]): Type => ({
  sectionedList: SectionedList.concatenateAll(
    adoptedFileSets.map((adoptedFileSet) => adoptedFileSet.sectionedList)
  ),
  notes: adoptedFileSets.flatMap((adoptedFileSet) => adoptedFileSet.notes),
})

export { concatenateAll }
export type { Type }
