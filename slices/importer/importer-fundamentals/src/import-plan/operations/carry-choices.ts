/**
 * Carry choices: the reviewer's choices on one plan of a batch carried onto
 * another plan of the same batch, read again under other settings.
 *
 * @packageDocumentation
 */
import { type FhirResourceWithId, sameStoredResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashMap, HashSet, Match, Option } from 'effect'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import type * as RecordKey from '../entities/record-key.ts'
import { differencesInPlan } from './differences-in-plan.ts'

/**
 * The reviewer's choices carried onto a plan read again: the plan, and the
 * keys of the records whose reviewer's choice was not carried because the
 * plan read again has no record under them, in the previous plan's order.
 */
interface CarriedChoices {
  readonly plan: ImportPlan.Type
  readonly notCarried: readonly RecordKey.Type[]
}

/** The reviewer's choice of each record of `plan` they chose for, by its key. */
const reviewerChoicesOf = (
  plan: ImportPlan.Type
): HashMap.HashMap<RecordKey.Type, RecordChoice.Type> =>
  HashMap.fromIterable(
    Arr.filterMap(plan.records, ({ record, chosen }) =>
      Option.map(chosen, (choice) => [record.key, choice] as const)
    )
  )

/**
 * `existing`, the stored record a reviewer's merge names, as the plan read
 * again knows it: the resource `planned`'s entry lists for the same stored
 * record (its candidates and the record under its derived id,
 * `PlannedRecord.existingRecordsOf`), else `existing` itself, which stays
 * the reviewer's own (`ChosenByReviewer`).
 */
const reboundExistingOf = (
  planned: PlannedRecord.Type,
  existing: FhirResourceWithId
): FhirResourceWithId =>
  Arr.findFirst(PlannedRecord.existingRecordsOf(planned), ({ resource }) =>
    sameStoredResource(resource, existing)
  ).pipe(
    Option.map(({ resource }) => resource),
    Option.getOrElse(() => existing)
  )

/**
 * `choice` as it carries onto `planned`, a record of `carried`: a merge
 * merges into its stored record as the plan read again found it
 * ({@link reboundExistingOf}) and, of its fields taken, keeps only those
 * that differ from it in `carried` (`differencesInPlan`); save as new and
 * don't add as they are.
 */
const carriedChoiceOf = (
  carried: ImportPlan.Type,
  planned: PlannedRecord.Type,
  choice: RecordChoice.Type
): RecordChoice.Type =>
  Match.value(choice).pipe(
    Match.tag('MergeIntoExistingRecord', ({ existing, fieldsTaken }) => {
      const rebound = reboundExistingOf(planned, existing)
      return RecordChoice.MergeIntoExistingRecord({
        existing: rebound,
        fieldsTaken: HashSet.intersection(
          fieldsTaken,
          HashSet.fromIterable(
            differencesInPlan(carried, planned, rebound).differences.map(({ field }) => field)
          )
        ),
      })
    }),
    Match.tag('SaveAsNewRecord', 'DontAdd', () => choice),
    Match.exhaustive
  )

/** The key of each record of `previous` the reviewer chose for that `next` has no record under. */
const notCarriedOf = (
  previous: ImportPlan.Type,
  next: ImportPlan.Type
): readonly RecordKey.Type[] =>
  Arr.filterMap(previous.records, ({ record, chosen }) =>
    Option.isSome(chosen) && Option.isNone(ImportPlan.get(next, record.key))
      ? Option.some(record.key)
      : Option.none()
  )

/**
 * The reviewer's choices on `previous` carried onto `next`, a plan of the
 * same batch read again under other settings.
 *
 * @param previous - The plan the reviewer made choices on
 * @param next - The plan of the batch as read again, as suggested
 * @returns `next` with each record's reviewer's choice on `previous`, where
 *   `previous` has a record under the same key, beside the keys of the
 *   records whose choice was not carried
 *
 * @remarks
 * Only a reviewer's choice carries (`PlannedRecord.chosen`), never a
 * suggestion: a record `previous` holds no choice for keeps `next`'s
 * suggestion, and so does a record only `next` holds. A choice for a record
 * only `previous` holds is not carried and its key is in `notCarried`: a
 * setting that changes a record's key (a health card province changing a
 * Patient's identifier) makes it another record. Save as new and don't add
 * carry as they are. A merge carries its stored record, as `next` found it
 * when `next` lists that stored record for the record, else as the
 * reviewer chose it, and, of its fields taken, only those that are still
 * differences from it in the carried plan, so a field that no longer
 * differs never turns a link into an update.
 *
 * A record's differences depend on the records ahead of it in merge order
 * (`differencesInPlan`), so the choices carry in merge order
 * (`ImportedRecord.inMergeOrder`): when a record's choice is carried, every
 * record ahead of it already holds its final choice and the records after it
 * do not count. So every carried merge's fields are a subset of its
 * differences in the plan returned.
 *
 * A reviewer's edit (`PlannedRecord.edit`) does not carry: `next`'s records
 * keep their own.
 */
const carryChoices = (previous: ImportPlan.Type, next: ImportPlan.Type): CarriedChoices => {
  const reviewerChoices = reviewerChoicesOf(previous)
  /** `carried` with the reviewer's choice of `planned`'s record carried onto it, when they made one. */
  const carryNext = (carried: ImportPlan.Type, planned: PlannedRecord.Type): ImportPlan.Type =>
    Option.match(HashMap.get(reviewerChoices, planned.record.key), {
      onNone: () => carried,
      onSome: (choice) =>
        ImportPlan.choose(carried, [planned.record.key], carriedChoiceOf(carried, planned, choice)),
    })
  return {
    plan: Arr.reduce(
      ImportedRecord.inMergeOrder(next.records, ({ record }) => record),
      next,
      carryNext
    ),
    notCarried: notCarriedOf(previous, next),
  }
}

export { carryChoices }
export type { CarriedChoices }
