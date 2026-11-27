import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  Difference,
  ImportPlan,
  PlannedRecord,
  RecordChoice,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PlanRecordRow } from './plan-record-row.tsx'
import * as PlanSections from './plan-sections.ts'
import { importedRecordOf, reviewedPlanOf, storedOf, tyraWire } from './plan.test-helpers.ts'

/** Tyra's Patient as `a.har` brings it, giving her a gender. */
const tyra = importedRecordOf(tyraWire({ gender: 'female' }), 'Patient/pat-7')

/** A stored Tyra with no gender. */
const stored = storedOf({ ...tyraWire(), id: 's-1' })

/** Tyra suggested `suggestion`, found by identifier as `stored` when `isFound`. */
const plannedOf = (suggestion: Suggestion.Type, isFound: boolean): PlannedRecord.Type =>
  PlannedRecord.make({
    record: tyra,
    storedMatch: StoredMatch.makeEntry(
      isFound ? [{ resource: stored, grade: 'certain', by: 'identifier' }] : [],
      Option.none()
    ),
    suggestion,
  })

/** The row of `planned`, alone in its plan, rendered. */
const renderRow = (
  planned: PlannedRecord.Type
): { readonly onChoose: ReturnType<typeof vi.fn>; readonly onReset: ReturnType<typeof vi.fn> } => {
  const plan = ImportPlan.make([planned], StoredMatch.empty)
  const reviewed = reviewedPlanOf(plan)
  const row = Option.getOrThrow(
    Arr.head(
      PlanSections.sectionsOf(reviewed).flatMap(({ groups }) =>
        groups.flatMap(PlanSections.rowsOfGroup)
      )
    )
  )
  const onChoose = vi.fn()
  const onReset = vi.fn()
  render(
    <PlanRecordRow
      row={row}
      reasonLine={PlanSections.reasonLineOf('People', row)}
      onChoose={onChoose}
      onReset={onReset}
    />
  )
  return { onChoose, onReset }
}

/** The row's choice. */
const choice = (): HTMLSelectElement =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'On import: Tyra Banks' })

/** The labels of the row's options. */
const optionLabels = (): readonly (string | null)[] =>
  [...choice().options].map((option) => option.textContent)

afterEach(cleanup)

describe('PlanRecordRow', () => {
  it('offers a new record its two choices, selects its suggestion, and has no chip or Reset', () => {
    renderRow(
      plannedOf(
        Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch()),
        false
      )
    )

    expect(optionLabels()).toEqual(['Save as a new record', "Don't add"])
    expect(choice().value).toBe('save-as-new')
    expect(screen.queryByText('Changed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
  })

  it('selects an identifier match’s update, and chooses another option', async () => {
    const { onChoose } = renderRow(
      plannedOf(
        Suggestion.make(
          Option.some(
            RecordChoice.mergeFillingGaps(stored, [Difference.FillsGap({ field: 'gender' })])
          ),
          Suggestion.OneIdentifierMatch()
        ),
        true
      )
    )

    expect(optionLabels()).toEqual(['Use Tyra Banks, updated', 'Save as a new record', "Don't add"])
    expect(choice().value).toBe('existing-0')
    expect(screen.getByText('a.har · Identifier match · 1 field differs')).toBeDefined()

    await userEvent.selectOptions(choice(), "Don't add")

    expect(onChoose.mock.calls).toEqual([[RecordChoice.DontAdd()]])
  })

  it('marks a changed row and resets it', async () => {
    const { onReset } = renderRow(
      PlannedRecord.withChoice(
        plannedOf(
          Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch()),
          false
        ),
        RecordChoice.DontAdd()
      )
    )

    expect(choice().value).toBe('dont-add')
    expect(screen.getByText('Changed')).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))

    expect(onReset).toHaveBeenCalledOnce()
  })
})
