import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { MedicationView } from 'medication-core/fhir'
import type { Medication } from 'medication-sponsorship-core'

import { MedicationsView } from './medications-view.tsx'

afterEach(cleanup)

const view = (medication: Medication, over: Partial<MedicationView> = {}): MedicationView => ({
  medication,
  din: null,
  description: null,
  requester: null,
  note: null,
  repeatsAllowed: null,
  repeatsAvailable: null,
  nextFillDate: null,
  rexallStoreUrl: null,
  shoppersStoreUrl: null,
  ...over,
})

describe('MedicationsView', () => {
  test('orders active medications first, then newest authored first, undated last', () => {
    const medications: readonly MedicationView[] = [
      view({ id: 'a', displayName: 'Older active', status: 'active', authoredOn: '2024-01-01' }),
      view({ id: 'b', displayName: 'Newer active', status: 'active', authoredOn: '2025-01-01' }),
      view({ id: 'c', displayName: 'Completed', status: 'completed', authoredOn: '2026-01-01' }),
      view({ id: 'd', displayName: 'Undated active', status: 'active' }),
    ]
    render(<MedicationsView medications={medications} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('Newer active')
    expect(rows[1]?.textContent).toContain('Older active')
    expect(rows[2]?.textContent).toContain('Undated active')
    expect(rows[3]?.textContent).toContain('Completed')
  })

  test('renders DIN, description, prescriber, notes and a combined repeats summary', () => {
    const medications: readonly MedicationView[] = [
      view(
        { id: '1', displayName: 'Atorvastatin', status: 'active' },
        {
          din: '02241497',
          description: '20 mg - Tablet',
          requester: 'Jane Smith',
          note: 'Take with food',
          repeatsAllowed: 3,
          repeatsAvailable: 2,
        }
      ),
    ]
    render(<MedicationsView medications={medications} />)

    expect(screen.getByText('DIN 02241497')).toBeDefined()
    expect(screen.getByText('20 mg - Tablet')).toBeDefined()
    expect(screen.getByText('Dr. Jane Smith')).toBeDefined()
    expect(screen.getByText('Take with food')).toBeDefined()
    expect(screen.getByText('2 / 3 Repeats Available')).toBeDefined()
  })

  test('shows neither fill timing nor eligibility chips — those live on other views', () => {
    const medications: readonly MedicationView[] = [
      view(
        { id: '1', displayName: 'Abilify 5 mg', status: 'active' },
        { nextFillDate: '2026-06-30T00:00:00.000Z', repeatsAllowed: 3, repeatsAvailable: 2 }
      ),
    ]
    render(<MedicationsView medications={medications} />)

    expect(screen.queryByText('Next fill')).toBeNull()
    expect(screen.queryByText('Supply exhausted')).toBeNull()
    expect(screen.queryByText(/2026-06-30/)).toBeNull()
    expect(screen.queryByText(/Eligible/)).toBeNull()
  })

  test('repeats: none-remaining is a danger "No Repeats Remaining"; no-allowance is "No Repeats"', () => {
    const medications: readonly MedicationView[] = [
      // Allowed but none left → danger label.
      view(
        { id: 'exhausted', displayName: 'Exhausted' },
        { repeatsAllowed: 3, repeatsAvailable: 0 }
      ),
      // Absent allowed count, and an explicit zero, both read as "No Repeats".
      view({ id: 'none', displayName: 'None' }, { repeatsAllowed: null, repeatsAvailable: null }),
      view(
        { id: 'zero', displayName: 'Zero allowed' },
        { repeatsAllowed: 0, repeatsAvailable: null }
      ),
    ]
    render(<MedicationsView medications={medications} />)

    const danger = screen.getByText('No Repeats Remaining')
    const neutral = screen.getAllByText('No Repeats')
    expect(neutral).toHaveLength(2)
    // The danger variant carries a different (red) class than the neutral ones.
    expect(danger.className).toContain('repeatsDanger')
    expect(danger.className).not.toBe(neutral[0]?.className)
  })

  test('renders a Rexall store link only when the request carries a store URL', () => {
    const medications: readonly MedicationView[] = [
      view(
        { id: 'rexall', displayName: 'From Rexall' },
        { rexallStoreUrl: 'https://www.rexall.ca/storelocator/store/8174' }
      ),
      view({ id: 'other', displayName: 'From elsewhere' }),
    ]
    render(<MedicationsView medications={medications} />)

    const rexallRow = screen
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('From Rexall'))
    expect(rexallRow).toBeDefined()
    if (rexallRow !== undefined) {
      const link = within(rexallRow).getByRole('link', { name: 'Rexall' })
      expect(link.getAttribute('href')).toBe('https://www.rexall.ca/storelocator/store/8174')
    }
    // Exactly one Rexall link across the list — the non-Rexall row has none.
    expect(screen.getAllByRole('link', { name: 'Rexall' })).toHaveLength(1)
  })

  test('renders a Shoppers store link only when the request carries a store URL', () => {
    const medications: readonly MedicationView[] = [
      view(
        { id: 'shoppers', displayName: 'From Shoppers' },
        { shoppersStoreUrl: 'https://www.shoppersdrugmart.ca/store-locator/store/1414' }
      ),
      view({ id: 'other', displayName: 'From elsewhere' }),
    ]
    render(<MedicationsView medications={medications} />)

    const shoppersRow = screen
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('From Shoppers'))
    expect(shoppersRow).toBeDefined()
    if (shoppersRow !== undefined) {
      const link = within(shoppersRow).getByRole('link', { name: 'Shoppers' })
      expect(link.getAttribute('href')).toBe(
        'https://www.shoppersdrugmart.ca/store-locator/store/1414'
      )
    }
    // Exactly one Shoppers link across the list — the non-Shoppers row has none.
    expect(screen.getAllByRole('link', { name: 'Shoppers' })).toHaveLength(1)
  })

  test('splits medications into "Active Medications" and "Completed" sections', () => {
    const medications: readonly MedicationView[] = [
      view({ id: 'a', displayName: 'Active one', status: 'active' }),
      view({ id: 'c', displayName: 'Done one', status: 'completed' }),
    ]
    render(<MedicationsView medications={medications} />)

    const active = screen.getByRole('heading', { name: 'Active Medications' })
    const completed = screen.getByRole('heading', { name: 'Completed' })
    // Each section owns only its own row.
    const activeList = active.nextElementSibling
    const completedList = completed.nextElementSibling
    expect(activeList?.textContent).toContain('Active one')
    expect(activeList?.textContent).not.toContain('Done one')
    expect(completedList?.textContent).toContain('Done one')
  })

  test('omits the Completed section when every medication is active', () => {
    render(
      <MedicationsView medications={[view({ id: 'a', displayName: 'A', status: 'active' })]} />
    )
    expect(screen.getByRole('heading', { name: 'Active Medications' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Completed' })).toBeNull()
  })

  test('shows an empty note under Active when all medications are completed', () => {
    render(
      <MedicationsView
        medications={[view({ id: 'c', displayName: 'Done', status: 'completed' })]}
      />
    )
    expect(screen.getByText('No active medications.')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeDefined()
  })

  test('renders an empty state when there are no medications', () => {
    render(<MedicationsView medications={[]} />)
    expect(screen.getByText('No medications found.')).toBeDefined()
  })
})
