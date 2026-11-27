/**
 * Differences in a plan: what merging one record of an import plan into an
 * existing record would change, given the choices made so far in the plan.
 *
 * @packageDocumentation
 */
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal } from 'effect'

import type * as Difference from '../entities/difference.ts'
import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as KeptRecords from '../entities/kept-records.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as ComparableReferences from './differences-of/comparable-references.ts'
import { differencesOf } from './differences-of/differences-of.ts'

/**
 * The two records a merge would compare, as they are, beside their
 * differences (`differencesOf`).
 *
 * @remarks
 * `incoming` and `kept` are the records compared, not the forms their
 * references were compared in, so a caller reads field values off them by a
 * difference's field, and the identifiers the merge would add as
 * `IdentifierUnion.missingFrom(kept's identifiers, incoming)`.
 */
interface DifferencesInPlan {
  /** The record as reviewed (`PlannedRecord.reviewedResourceOf`). */
  readonly incoming: FhirResource
  /** The existing record as the records ahead of it in merge order leave it. */
  readonly kept: FhirResourceWithId
  readonly differences: readonly Difference.Type[]
}

/**
 * The records of `plan` ahead of `planned` in merge order
 * (`ImportedRecord.inMergeOrder`): earlier in `ImportedRecord.mergeOrder`,
 * then in plan order.
 */
const aheadOf = (
  plan: ImportPlan.Type,
  planned: PlannedRecord.Type
): readonly PlannedRecord.Type[] =>
  Arr.takeWhile(
    ImportedRecord.inMergeOrder(plan.records, ({ record }) => record),
    ({ record }) => !Equal.equals(record.key, planned.record.key)
  )

/**
 * `existing` as the records of `plan` ahead of `planned` leave it, each
 * merging into it by its effective choice with its reviewed resource
 * (`KeptRecords.fromRecordChoices` of them as reviewed).
 */
const keptAhead = (
  plan: ImportPlan.Type,
  planned: PlannedRecord.Type,
  existing: FhirResourceWithId
): FhirResourceWithId =>
  KeptRecords.asMergedIn(
    KeptRecords.fromRecordChoices(aheadOf(plan, planned).map(KeptRecords.asReviewed)),
    existing
  )

/**
 * The differences of `planned`, a record of `plan`, from `existing`, a
 * record it could merge into, given the choices made so far in the plan.
 *
 * @param plan - The plan, the reviewer's choices made
 * @param planned - The record merged in, one of `plan`'s
 * @param existing - The record it would merge into: a candidate, which need
 *   not be the record's current choice
 * @returns The record as reviewed (`incoming`), `existing` as the records
 *   ahead of `planned` in merge order leave it (`kept`), and the differences
 *   between them
 *
 * @remarks
 * Each record ahead of `planned` in merge order (`ImportedRecord.mergeOrder`,
 * then plan order) merges into `existing` by its effective choice, the
 * reviewer's else the suggestion's, with its reviewed resource; `planned`
 * itself and the records after it never do. References compare by what they
 * name (`ComparableReferences`), as `suggestPlan` compares them.
 *
 * It rebuilds the comparable references of the whole plan on each call, so
 * a caller showing many rows should cache the results.
 */
const differencesInPlan = (
  plan: ImportPlan.Type,
  planned: PlannedRecord.Type,
  existing: FhirResourceWithId
): DifferencesInPlan => {
  const incoming = PlannedRecord.reviewedResourceOf(planned)
  const kept = keptAhead(plan, planned, existing)
  return {
    incoming,
    kept,
    differences: differencesOf(
      incoming,
      kept,
      ComparableReferences.of(
        plan.records.map(({ record }) => record),
        plan.storedMatch
      )
    ),
  }
}

export { differencesInPlan }
export type { DifferencesInPlan }
