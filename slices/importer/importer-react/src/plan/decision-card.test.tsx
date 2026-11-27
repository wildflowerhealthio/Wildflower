import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  Difference,
  ImportPlan,
  PlannedRecord,
  RecordChoice,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { DateTime, Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { DecisionCard } from './decision-card.tsx'
import * as PlanDifferences from './plan-differences.ts'
import {
  importedRecordOf,
  needingDecision,
  probableMatch,
  storedOf,
  tyraWire,
} from './plan.test-helpers.ts'

const NOW = DateTime.unsafeMake('2026-11-27T12:00:00Z')

/** Tyra's Patient as `a.har` brings it, giving her a gender and a phone number. */
const tyra = importedRecordOf(
  tyraWire({
    identifier: [{ system: 'https://a.example/Patient', value: 'pat-7' }],
    gender: 'female',
    telecom: [{ system: 'phone', value: '555-0199' }],
  }),
  'Patient/pat-7'
)

/** A stored Tyra with another phone number and no gender, last updated on 2026-06-02. */
const withPhone = storedOf({
  ...tyraWire({ telecom: [{ system: 'phone', value: '555-0100' }] }),
  id: 's-1',
  meta: { lastUpdated: '2026-06-02T14:00:00Z' },
})

/** A stored Tyra with nothing but her name and birth date. */
const bare = storedOf({ ...tyraWire(), id: 's-2' })

/** The card of Tyra matched to both stored Tyras, with `choice` made, referenced by two records. */
const renderCard = (
  choice: Option.Option<RecordChoice.Type>
): { readonly onChoose: ReturnType<typeof vi.fn> } => {
  const suggested = needingDecision(tyra, [probableMatch(withPhone), probableMatch(bare)])
  const planned = Option.match(choice, {
    onNone: () => suggested,
    onSome: (chosen) => PlannedRecord.withChoice(suggested, chosen),
  })
  return renderPlanned(planned, 2)
}

/** The card of `planned`, referenced by `referrers` records, alone in its plan. */
const renderPlanned = (
  planned: PlannedRecord.Type,
  referrers: number
): { readonly onChoose: ReturnType<typeof vi.fn> } => {
  const differences = PlanDifferences.ofPlan(ImportPlan.make([planned], StoredMatch.empty))
  const onChoose = vi.fn()
  render(
    <DecisionCard
      planned={planned}
      now={NOW}
      referrers={referrers}
      candidates={PlanDifferences.candidatesOf(differences, planned.record.key)}
      domId="import-plan-record-0"
      importing={false}
      onChoose={onChoose}
    />
  )
  return { onChoose }
}

/** The card's option whose radio is `radio`. */
const optionOf = (radio: HTMLElement): HTMLElement => {
  const option = radio.closest<HTMLElement>('label')?.parentElement
  if (option === null || option === undefined) throw new Error('The radio is in no option')
  return option
}

afterEach(() => {
  cleanup()
})

describe('DecisionCard', () => {
  it('says nothing is selected, and shows each option with the fields the options differ on', () => {
    // Act
    renderCard(Option.none())

    // Assert
    const card = screen.getByRole('region', {
      name: 'Select a Patient record for Tyra Banks from a.har',
    })
    expect(
      within(card).getByText(
        'Not selected · 2 possible matches · referenced by 2 records · same name, birthDate'
      )
    ).toBeDefined()
    const radios = within(card).getAllByRole<HTMLInputElement>('radio')
    expect(radios.map((radio) => radio.checked)).toEqual([false, false, false, false])
    expect(
      radios
        .slice(0, 3)
        .map((radio) =>
          [...optionOf(radio).querySelectorAll('dt, dd')].map((cell) => cell.textContent)
        )
    ).toEqual([
      ['gender', 'female', 'telecom', 'phone 555-0199'],
      ['gender', 'Not recorded', 'telecom', 'phone 555-0100'],
      ['gender', 'Not recorded', 'telecom', 'Not recorded'],
    ])
    expect(within(optionOf(radios[1] as HTMLElement)).getByText('Differences')).toBeDefined()
    expect(within(card).queryByRole('checkbox')).toBeNull()
  })

  it('takes the gap-filling fields when an existing record is used', async () => {
    // Arrange
    const { onChoose } = renderCard(Option.none())

    // Act
    await userEvent.click(
      screen.getByRole('radio', { name: 'Use this existing record', description: /2026-06-02/u })
    )

    // Assert
    expect(onChoose.mock.calls).toEqual([
      [RecordChoice.mergeTakingEveryField(withPhone, [Difference.FillsGap({ field: 'gender' })])],
    ])
  })

  it('shows the update checkbox and the outcome of the existing record selected', () => {
    // Act
    renderCard(
      Option.some(
        RecordChoice.mergeTakingEveryField(withPhone, [Difference.FillsGap({ field: 'gender' })])
      )
    )

    // Assert
    const used = screen.getByRole<HTMLInputElement>('radio', {
      name: 'Use this existing record',
      description: /2026-06-02/u,
    })
    expect(used.checked).toBe(true)
    const option = optionOf(used)
    const update = within(option).getByRole<HTMLInputElement>('checkbox')
    expect([update.labels?.[0]?.textContent, update.indeterminate]).toEqual([
      'Update with import details · 1 of 2',
      true,
    ])
    expect(
      within(option).getByText(
        '2 records will reference this record instead, with 1 field updated.'
      )
    ).toBeDefined()
    expect(screen.queryByText(/^Not selected/u)).toBeNull()
  })

  it("says what Don't add leaves when it is selected", () => {
    // Act
    renderCard(Option.some(RecordChoice.DontAdd()))

    // Assert
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^Don't add/u }).checked).toBe(true)
    expect(
      screen.getByText('· 2 records keep the display “Tyra Banks” with no reference')
    ).toBeDefined()
    expect(screen.queryByText(/will reference/u)).toBeNull()
  })

  it('counts the existing records that carry its identifier, with no fields agreed on, for a record several carry the identifier of', () => {
    // Arrange — two stored Tyras carrying the imported record's identifier, nothing referencing it
    const carrying = (id: string): ReturnType<typeof storedOf> =>
      storedOf({
        ...tyraWire({ identifier: [{ system: 'https://a.example/Patient', value: 'pat-7' }] }),
        id,
      })
    const planned = PlannedRecord.make({
      record: tyra,
      storedMatch: StoredMatch.makeEntry(
        [carrying('s-3'), carrying('s-4')].map((resource) => ({
          resource,
          grade: 'certain' as const,
          by: 'identifier' as const,
        })),
        Option.none()
      ),
      suggestion: Suggestion.make(Option.none(), Suggestion.SeveralIdentifierMatches()),
    })

    // Act
    renderPlanned(planned, 0)

    // Assert
    const card = screen.getByRole('region', {
      name: 'Select a Patient record for Tyra Banks from a.har',
    })
    expect(within(card).getByText('Not selected · 2 identifier matches')).toBeDefined()
    expect(
      within(card)
        .getAllByRole('radio', { name: 'Use this existing record' })
        .map((radio) => radio.getAttribute('value'))
    ).toEqual(['Patient/s-3', 'Patient/s-4'])
  })
})
