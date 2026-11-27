/**
 * Row options: what a row of Decided automatically offers its record, in
 * order, each with the choice picking it makes, and which one its record's
 * choice is.
 *
 * @packageDocumentation
 */
import { sameStoredResource } from '@wildflowerhealthio/fhir-r4/resources'
import { PlannedRecord, RecordChoice } from '@wildflowerhealthio/importer-fundamentals'
import type { RecordRowTone } from '@wildflowerhealthio/react-tundraish'
import { Array as Arr, Match, Option } from 'effect'

import * as PlanDifferences from './plan-differences.ts'
import type * as PlanSections from './plan-sections.ts'
import { DONT_ADD_LABEL, SAVE_AS_NEW_LABEL, useRecordLabel } from './plan-text.ts'

/** An option's value in the row's `<select>`: an existing record by its place among the candidates, or a choice of no existing record. */
type RowOptionValue = `existing-${number}` | 'save-as-new' | 'dont-add'

/** One option of a row: its value, its label, its tone, and the choice picking it makes. */
interface RowOption {
  readonly value: RowOptionValue
  readonly label: string
  readonly tone: RecordRowTone
  readonly choice: RecordChoice.Type
}

/** The value of the option of the candidate at `index`. */
const existingValue = (index: number): RowOptionValue => `existing-${index}`

/** A choice that merges into an existing record. */
type Merge = Extract<RecordChoice.Type, { readonly _tag: 'MergeIntoExistingRecord' }>

/** Whether `merge` merges into `candidate`'s existing record. */
const mergesInto = (merge: Merge, candidate: PlanDifferences.Candidate): boolean =>
  sameStoredResource(candidate.existing, merge.existing)

/** The merge `planned`'s choice is, when it merges into an existing record. */
const effectiveMergeOf = (planned: PlannedRecord.Type): Option.Option<Merge> =>
  Option.filter(PlannedRecord.effectiveChoice(planned), RecordChoice.is('MergeIntoExistingRecord'))

/**
 * The value of the option `planned`'s choice is: the candidate a merge
 * merges into, else save as new or don't add; `None` when it has no choice,
 * or merges into none of `candidates`.
 */
const selectedValueOf = (
  planned: PlannedRecord.Type,
  candidates: readonly PlanDifferences.Candidate[]
): Option.Option<RowOptionValue> =>
  Option.flatMap(PlannedRecord.effectiveChoice(planned), (choice) =>
    Match.value(choice).pipe(
      Match.tagsExhaustive({
        MergeIntoExistingRecord: (merge) =>
          Option.map(
            Arr.findFirstIndex(candidates, (candidate) => mergesInto(merge, candidate)),
            existingValue
          ),
        SaveAsNewRecord: (): Option.Option<RowOptionValue> => Option.some('save-as-new'),
        DontAdd: (): Option.Option<RowOptionValue> => Option.some('dont-add'),
      })
    )
  )

/**
 * Whether `choice` updates `candidate`: it merges into it and takes at least
 * one of the candidate's current differences (`PlanDifferences.takenAmong`).
 */
const updates = (choice: RecordChoice.Type, candidate: PlanDifferences.Candidate): boolean =>
  Option.exists(
    PlanDifferences.fieldsTakenInto(Option.some(choice), candidate.existing),
    (fieldsTaken) => PlanDifferences.takenAmong(candidate.inPlan.differences, fieldsTaken) > 0
  )

/**
 * The options of `row`, in order: one per candidate, "Use Tyra Banks", with
 * ", updated" when the merge it stands for {@link updates} the existing
 * record; then save as new; then don't add.
 *
 * @remarks
 * A candidate's option stands for the record's own merge when that merges
 * into it, else for the merge picking it makes: taking the fields that fill
 * a gap among its current differences (`RecordChoice.mergeFillingGaps`).
 * The tones are the choice's: save as new is `accent`, a merge that updates
 * `success`, a merge that only links `neutral`, don't add `muted`.
 */
const rowOptionsOf = (row: PlanSections.Row): readonly RowOption[] => {
  const ownMerge = effectiveMergeOf(row.resolved.planned)
  return [
    ...row.candidates.map(({ candidate, title }, index): RowOption => {
      const choice = RecordChoice.mergeFillingGaps(candidate.existing, candidate.inPlan.differences)
      const standsFor = Option.getOrElse(
        Option.filter(ownMerge, (own) => mergesInto(own, candidate)),
        (): RecordChoice.Type => choice
      )
      const isUpdate = updates(standsFor, candidate)
      return {
        value: existingValue(index),
        label: useRecordLabel({ title, updates: isUpdate }),
        tone: isUpdate ? 'success' : 'neutral',
        choice,
      }
    }),
    {
      value: 'save-as-new',
      label: SAVE_AS_NEW_LABEL,
      tone: 'accent',
      choice: RecordChoice.SaveAsNewRecord(),
    },
    { value: 'dont-add', label: DONT_ADD_LABEL, tone: 'muted', choice: RecordChoice.DontAdd() },
  ]
}

export { rowOptionsOf, selectedValueOf }
export type { RowOption, RowOptionValue }
