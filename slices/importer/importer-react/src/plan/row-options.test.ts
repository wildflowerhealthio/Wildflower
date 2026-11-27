import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Difference,
  ImportPlan,
  PlannedRecord,
  RecordChoice,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as PlanDifferences from './plan-differences.ts'
import * as PlanSections from './plan-sections.ts'
import { importedRecordOf, reviewedPlanOf, storedOf, tyraWire } from './plan.test-helpers.ts'
import { rowOptionsOf, selectedValueOf } from './row-options.ts'

/** Tyra as `a.har` brings her, giving her a gender and a phone number. */
const tyra = importedRecordOf(
  tyraWire({ gender: 'female', telecom: [{ system: 'phone', value: '555-0199' }] }),
  'Patient/pat-7'
)

/** A stored Tyra with another phone number and no gender: the import fills one gap and overwrites one field. */
const withPhone = storedOf({
  ...tyraWire({ telecom: [{ system: 'phone', value: '555-0100' }] }),
  id: 's-1',
})

/** A stored Tyra that differs from the import on no field. */
const same = storedOf({
  ...tyraWire({ gender: 'female', telecom: [{ system: 'phone', value: '555-0199' }] }),
  id: 's-2',
})

/** A stored Tyra no search found. */
const elsewhere = storedOf({ ...tyraWire(), id: 's-3' })

/** Tyra matched by identifier to `withPhone` and `same`, suggested to link to `same`, with `chosen` made. */
const plannedWith = (chosen: Option.Option<RecordChoice.Type>): PlannedRecord.Type => {
  const suggested = PlannedRecord.make({
    record: tyra,
    storedMatch: StoredMatch.makeEntry(
      [withPhone, same].map(
        (resource) => ({ resource, grade: 'certain', by: 'identifier' }) as const
      ),
      Option.none()
    ),
    suggestion: Suggestion.make(
      Option.some(RecordChoice.mergeTakingNoField(same)),
      Suggestion.OneIdentifierMatch()
    ),
  })
  return Option.match(chosen, {
    onNone: () => suggested,
    onSome: (choice) => PlannedRecord.withChoice(suggested, choice),
  })
}

/** The row of `planned`, alone in its plan. */
const rowOf = (planned: PlannedRecord.Type): PlanSections.Row =>
  Option.getOrThrow(
    Arr.head(
      PlanSections.sectionsOf(
        reviewedPlanOf(ImportPlan.make([planned], StoredMatch.empty))
      ).flatMap(({ groups }) => groups.flatMap(PlanSections.rowsOfGroup))
    )
  )

/** The candidates worked out for `planned`, alone in its plan. */
const candidatesOf = (planned: PlannedRecord.Type): readonly PlanDifferences.Candidate[] =>
  PlanDifferences.candidatesOf(
    PlanDifferences.ofPlan(ImportPlan.make([planned], StoredMatch.empty)),
    tyra.key
  )

describe('selectedValueOf', () => {
  it('selects the option of every effective choice, and none for a merge into no candidate', () => {
    const choices: readonly Option.Option<RecordChoice.Type>[] = [
      Option.none(),
      Option.some(RecordChoice.mergeTakingEveryField(withPhone, [])),
      Option.some(RecordChoice.SaveAsNewRecord()),
      Option.some(RecordChoice.DontAdd()),
    ]
    expect(
      choices.map((chosen) => {
        const planned = plannedWith(chosen)
        return selectedValueOf(planned, candidatesOf(planned))
      })
    ).toEqual([
      Option.some('existing-1'),
      Option.some('existing-0'),
      Option.some('save-as-new'),
      Option.some('dont-add'),
    ])
    const toElsewhere = plannedWith(Option.some(RecordChoice.mergeTakingNoField(elsewhere)))
    expect(selectedValueOf(toElsewhere, candidatesOf(toElsewhere).slice(0, 2))).toEqual(
      Option.none()
    )
  })
})

describe('rowOptionsOf', () => {
  /** Each option's value, label, tone, and whether picking it makes `choice`. */
  const optionsOf = (
    planned: PlannedRecord.Type,
    existing: FhirResourceWithId
  ): readonly {
    readonly value: string
    readonly label: string
    readonly tone: string
    readonly fillsGaps: boolean
  }[] => {
    const differences = candidatesOf(planned)[0]?.inPlan.differences ?? []
    return rowOptionsOf(rowOf(planned)).map(({ value, label, tone, choice }) => ({
      value,
      label,
      tone,
      fillsGaps: RecordChoice.equivalence(
        choice,
        RecordChoice.mergeFillingGaps(existing, differences)
      ),
    }))
  }

  it('says updated of an option exactly when the merge it stands for takes a current difference', () => {
    // The suggestion links to `same`; picking `withPhone` would fill its gender gap
    expect(optionsOf(plannedWith(Option.none()), withPhone).slice(0, 2)).toEqual([
      { value: 'existing-0', label: 'Use Tyra Banks, updated', tone: 'success', fillsGaps: true },
      { value: 'existing-1', label: 'Use Tyra Banks', tone: 'neutral', fillsGaps: false },
    ])
    // Merged into `withPhone` taking no field: its option says so though a field would fill a gap
    expect(
      optionsOf(plannedWith(Option.some(RecordChoice.mergeTakingNoField(withPhone))), withPhone)
        .slice(0, 1)
        .map(({ label, tone }) => [label, tone])
    ).toEqual([['Use Tyra Banks', 'neutral']])
    // Merged into `withPhone` taking only the overwrite: still a current difference taken
    expect(
      optionsOf(
        plannedWith(
          Option.some(
            RecordChoice.mergeTakingEveryField(withPhone, [
              Difference.Overwrites({ field: 'telecom' }),
            ])
          )
        ),
        withPhone
      )
        .slice(0, 1)
        .map(({ label, tone }) => [label, tone])
    ).toEqual([['Use Tyra Banks, updated', 'success']])
  })

  it('offers save as new, then don’t add, after the existing records', () => {
    expect(
      rowOptionsOf(rowOf(plannedWith(Option.none())))
        .slice(2)
        .map(({ value, label, tone, choice }) => [value, label, tone, choice._tag])
    ).toEqual([
      ['save-as-new', 'Save as a new record', 'accent', 'SaveAsNewRecord'],
      ['dont-add', "Don't add", 'muted', 'DontAdd'],
    ])
  })
})
