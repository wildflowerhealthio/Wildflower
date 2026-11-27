/**
 * An import write: what a resolved import plan writes, as one transaction,
 * or the records that block it.
 *
 * @packageDocumentation
 */
import { type FhirResourceWithId, sameStoredResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Data, Option } from 'effect'

import type * as PlanResolution from './plan-resolution.ts'
import * as PlannedRecord from './planned-record.ts'
import type * as RecordKey from './record-key.ts'

/**
 * `Ready` with the resources of one transaction, each once, in plan order,
 * or `Blocked` by the records that have no choice, in plan order.
 */
type Type = Data.TaggedEnum<{
  Ready: { readonly resources: readonly FhirResourceWithId[] }
  Blocked: { readonly undecided: Arr.NonEmptyReadonlyArray<RecordKey.Type> }
}>

const { Ready, Blocked, $match: match } = Data.taggedEnum<Type>()

/**
 * The write of `resolution`: `Blocked` while any record has no choice, else
 * `Ready` with what is written for every record, each resource once by its
 * literal reference, where its first record is in plan order.
 *
 * @remarks
 * Records that merge into one stored record share its one write, so it is written
 * once.
 */
const of = (resolution: PlanResolution.Type): Type => {
  const undecided = resolution.records
    .filter(({ planned }) => Option.isNone(PlannedRecord.effectiveChoice(planned)))
    .map(({ planned }) => planned.record.key)
  return Arr.isNonEmptyReadonlyArray(undecided)
    ? Blocked({ undecided })
    : Ready({
        resources: Arr.dedupeWith(
          Arr.flatMap(resolution.records, ({ written }) => Option.toArray(written)),
          sameStoredResource
        ),
      })
}

/** Whether `write` is ready and writes nothing: no record has a write and none is undecided. */
const isNothingToImport = (write: Type): boolean =>
  write._tag === 'Ready' && write.resources.length === 0

export { isNothingToImport, match, of }
export type { Type }
