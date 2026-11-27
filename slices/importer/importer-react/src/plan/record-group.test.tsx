import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  ImportPlan,
  PlannedRecord,
  RecordChoice,
  type RecordKey,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { recordKeyText } from './decision-card-ids.ts'
import * as PlanSections from './plan-sections.ts'
import { DONT_ADD_ANY_LABEL, RESET_TO_SUGGESTED_LABEL, setEveryLabel } from './plan-text.ts'
import { importedRecordOf, reviewedPlanOf, storedOf } from './plan.test-helpers.ts'
import { RecordGroup } from './record-group.tsx'

/** The wire of the `index`th Observation. */
const observationWire = (index: number): object => ({
  resourceType: 'Observation',
  status: 'final',
  code: { text: `Observation ${index}` },
})

/** A new Observation, suggested to be saved as new. */
const newObservation = (index: number): PlannedRecord.Type =>
  PlannedRecord.make({
    record: importedRecordOf(observationWire(index), `Observation/new-${index}`),
    storedMatch: StoredMatch.makeEntry([], Option.none()),
    suggestion: Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch()),
  })

/** An Observation the same as the stored one carrying its identifier, suggested to link to it. */
const storedObservation = (index: number): PlannedRecord.Type => {
  const stored = storedOf({ ...observationWire(index), id: `s-${index}` })
  return PlannedRecord.make({
    record: importedRecordOf(observationWire(index), `Observation/same-${index}`),
    storedMatch: StoredMatch.makeEntry(
      [{ resource: stored, grade: 'certain', by: 'identifier' }],
      Option.none()
    ),
    suggestion: Suggestion.make(
      Option.some(RecordChoice.mergeTakingNoField(stored)),
      Suggestion.OneIdentifierMatch()
    ),
  })
}

/** Pick `item` off the Observation group's menu. */
const chooseFromMenu = async (item: string): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: setEveryLabel('Observation') }))
  await userEvent.click(screen.getByRole('menuitem', { name: item }))
}

afterEach(cleanup)

describe('RecordGroup', () => {
  it('sets every record of the group from its menu, the rows not shown and those folded included', async () => {
    // Arrange — eight new Observations, six of them shown, and two the same as stored ones
    const plan = ImportPlan.make(
      [...Arr.makeBy(8, newObservation), ...Arr.makeBy(2, (index) => storedObservation(8 + index))],
      StoredMatch.empty
    )
    const group = Option.getOrThrow(
      Arr.head(PlanSections.sectionsOf(reviewedPlanOf(plan)).flatMap(({ groups }) => groups))
    )
    const onChoose = vi.fn<(keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void>()
    const onReset = vi.fn<(keys: Iterable<RecordKey.Type>) => void>()
    render(<RecordGroup group={group} sectionTag="FileSet" onChoose={onChoose} onReset={onReset} />)
    expect([screen.getAllByRole('combobox').length, group.folded.length]).toEqual([6, 2])

    // Act
    await chooseFromMenu(DONT_ADD_ANY_LABEL)
    await chooseFromMenu(RESET_TO_SUGGESTED_LABEL)

    // Assert
    const everyKey = plan.records.map(({ record }) => recordKeyText(record.key))
    expect(
      onChoose.mock.calls.map(([keys, choice]) => [[...keys].map(recordKeyText).toSorted(), choice])
    ).toEqual([[everyKey.toSorted(), RecordChoice.DontAdd()]])
    expect(onReset.mock.calls.map(([keys]) => [...keys].map(recordKeyText).toSorted())).toEqual([
      everyKey.toSorted(),
    ])
  })
})
