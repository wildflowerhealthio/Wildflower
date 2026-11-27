/**
 * The kept records of an import: each stored record the import's records
 * merge into, as a kept record with their merges in merge order
 * (`ImportedRecord.mergeOrder`).
 *
 * @packageDocumentation
 */
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Option, pipe, Record } from 'effect'

import * as ImportedRecord from './imported-record.ts'
import * as KeptRecord from './kept-record.ts'
import * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'
import type * as ReferenceTable from './reference-table.ts'

/** Each kept record, by its stored literal: the `Type/id` it is stored under. */
type Type = Record.ReadonlyRecord<string, KeptRecord.Type>

/** No stored record merged into yet. */
const empty: Type = Record.empty()

/**
 * A record of the plan beside the resource it brings into a merge: its
 * resource as reviewed ({@link asReviewed}), or that resource with its
 * references resolved.
 */
interface IncomingRecord {
  readonly planned: PlannedRecord.Type
  readonly incoming: FhirResource
}

/** `planned` bringing its resource as reviewed (`PlannedRecord.reviewedResourceOf`). */
const asReviewed = (planned: PlannedRecord.Type): IncomingRecord => ({
  planned,
  incoming: PlannedRecord.reviewedResourceOf(planned),
})

/** One merge beside the stored record it goes into. */
interface MergeInto {
  readonly existing: FhirResourceWithId
  readonly merge: KeptRecord.Merge
}

/**
 * The merge `incomingRecord` makes: by its effective choice
 * (`PlannedRecord.effectiveChoice`), when that merges it into a stored
 * record, its resource with the fields the choice takes, replacing the kept
 * record's content whole when the resource is the reviewer's edit. `None`
 * for any other choice, or none.
 */
const mergeOf = ({ planned, incoming }: IncomingRecord): Option.Option<MergeInto> =>
  pipe(
    PlannedRecord.effectiveChoice(planned),
    Option.filter(RecordChoice.is('MergeIntoExistingRecord')),
    Option.map(({ existing, fieldsTaken }) => ({
      existing,
      merge: { incoming, fieldsTaken, isEdit: Option.isSome(planned.edit) },
    }))
  )

/**
 * The kept records `incomingRecords` merge into, each with every merge into
 * it ({@link mergeOf}) in merge order.
 *
 * @remarks
 * The one place "the records that merge into one kept record do so in merge
 * order" is kept: the records are put in merge order here
 * (`ImportedRecord.inMergeOrder`: decoded records before implied ones, each
 * group in the order given), whatever order they come in.
 */
const fromRecordChoices = (incomingRecords: readonly IncomingRecord[]): Type =>
  pipe(
    ImportedRecord.inMergeOrder(incomingRecords, ({ planned }) => planned.record),
    Arr.filterMap(mergeOf),
    Arr.groupBy(({ existing }) => literalReferenceOf(existing)),
    Record.map((mergesInto) =>
      KeptRecord.make(
        Arr.headNonEmpty(mergesInto).existing,
        mergesInto.map(({ merge }) => merge)
      )
    )
  )

/**
 * `keptRecords` with the merge `incomingRecord` makes ({@link mergeOf}) made
 * after the merges already in them; as they are when it makes none.
 *
 * @remarks
 * For a caller that must read the kept records between one record's choice
 * and the next, as suggesting a plan does, and so walks the records in merge
 * order itself. Any other caller builds them whole
 * ({@link fromRecordChoices}).
 */
const withRecordChoice = (keptRecords: Type, incomingRecord: IncomingRecord): Type =>
  Option.match(mergeOf(incomingRecord), {
    onNone: () => keptRecords,
    onSome: ({ existing, merge }) => {
      const storedLiteral = literalReferenceOf(existing)
      const mergedSoFar = Option.getOrElse(Record.get(keptRecords, storedLiteral), () =>
        KeptRecord.make(existing, [])
      )
      return Record.set(keptRecords, storedLiteral, KeptRecord.withMerge(mergedSoFar, merge))
    },
  })

/** `existing` as merged once the records of `keptRecords` that merge into it have (`KeptRecord.asMerged`); itself when none does. */
const asMergedIn = (keptRecords: Type, existing: FhirResourceWithId): FhirResourceWithId =>
  Option.match(Record.get(keptRecords, literalReferenceOf(existing)), {
    onNone: () => existing,
    onSome: KeptRecord.asMerged,
  })

/** What is written for each kept record that is written, by its stored literal. */
type Writes = Record.ReadonlyRecord<string, FhirResourceWithId>

/**
 * What is written for each of `keptRecords`, its links landed by `table`
 * (`KeptRecord.writtenOf`); a kept record nothing is written for has no
 * entry.
 */
const writesOf = (table: ReferenceTable.Type, keptRecords: Type): Writes =>
  Record.filterMap(keptRecords, (keptRecord) => KeptRecord.writtenOf(table, keptRecord))

/** What `writes` holds for `existing`; `None` when nothing is written for it. */
const writeFor = (
  writes: Writes,
  existing: FhirResourceWithId
): Option.Option<FhirResourceWithId> => Record.get(writes, literalReferenceOf(existing))

export { asMergedIn, asReviewed, empty, fromRecordChoices, withRecordChoice, writeFor, writesOf }
export type { IncomingRecord, Type, Writes }
