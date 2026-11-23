/**
 * A plan's resolution: each record of an import plan resolved, with the id
 * it is written under or links to, its references once resolved, what is
 * written for it, and how the plan counts it.
 *
 * @packageDocumentation
 */
import {
  type FhirResource,
  type FhirResourceWithId,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Option, Schema } from 'effect'

import * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'

/**
 * How the plan counts a resolved record: its choice's label
 * (`PlannedRecord.Label`), or `Unneeded` for a record whose choice would
 * write or link it but that nothing written names, so nothing is written for
 * it.
 */
const LabelSchema = Schema.Literal(...PlannedRecord.LabelSchema.literals, 'Unneeded')

type Label = typeof LabelSchema.Type

/** Every {@link Label}, in the order the plan's totals list them. */
const labels: readonly Label[] = LabelSchema.literals

/**
 * One record of the plan resolved.
 *
 * @remarks
 * `id` is the id it is written under or links to, `None` when it is not
 * added or has no choice. Records that merge into one stored record share
 * one write, the kept record with every one of their merges, so each of them
 * has that write as its `written`.
 */
interface ResolvedRecord {
  readonly planned: PlannedRecord.Type
  readonly label: Label
  readonly id: Option.Option<string>
  /** Every reference of the record as reviewed (its edit, else its resource), once resolved. */
  readonly resolvedReferences: readonly ResourceReferences.ReferenceAt[]
  /** What is written for it; `None` when nothing is. */
  readonly written: Option.Option<FhirResourceWithId>
}

/** Every record of a plan resolved, in plan order. */
interface Type {
  readonly records: readonly ResolvedRecord[]
}

/** What a record is resolved from: the record, its id, its resource as reviewed once resolved. */
interface RecordFacts {
  readonly planned: PlannedRecord.Type
  readonly id: Option.Option<string>
  readonly resolved: FhirResource
}

/**
 * How a record whose choice writes or links it is counted, `written` written
 * for it: a record that merges into a stored record is `Update` when something is
 * written for that stored record (a taken field, an edit, an identifier or a
 * link it gains) and `LinkToExisting` when nothing is; any other by its
 * choice (`PlannedRecord.labelOf`).
 */
const labelOf = (
  planned: PlannedRecord.Type,
  written: Option.Option<FhirResourceWithId>
): Label => {
  if (
    !Option.exists(
      PlannedRecord.effectiveChoice(planned),
      RecordChoice.is('MergeIntoExistingRecord')
    )
  ) {
    return PlannedRecord.labelOf(planned)
  }
  return Option.isSome(written) ? 'Update' : 'LinkToExisting'
}

/** `planned` resolved, labelled by what happens to it ({@link labelOf}), `written` written for it. */
const makeRecord = (
  { planned, id, resolved }: RecordFacts,
  written: Option.Option<FhirResourceWithId>
): ResolvedRecord => ({
  planned,
  label: labelOf(planned, written),
  id,
  resolvedReferences: ResourceReferences.collect(resolved),
  written,
})

/** `planned` resolved as unneeded: nothing written names it, so nothing is written for it. */
const makeUnneededRecord = ({ planned, id, resolved }: RecordFacts): ResolvedRecord => ({
  planned,
  label: 'Unneeded',
  id,
  resolvedReferences: ResourceReferences.collect(resolved),
  written: Option.none(),
})

/** The resolution of a plan's `records`, in plan order. */
const make = (records: readonly ResolvedRecord[]): Type => ({ records })

export { LabelSchema, labels, make, makeRecord, makeUnneededRecord }
export type { Label, RecordFacts, ResolvedRecord, Type }
