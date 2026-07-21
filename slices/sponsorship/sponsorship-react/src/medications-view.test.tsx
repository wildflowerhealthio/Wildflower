import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  allProvinces,
  type Medication,
  type SponsorCatalog,
  type SponsoredDrug,
} from 'sponsorship-core'

import type { MedicationView } from './medication.ts'
import { MedicationsView } from './medications-view.tsx'

afterEach(cleanup)

const drug = (over: Partial<SponsoredDrug>): SponsoredDrug => ({
  sponsor: 'innovicares',
  id: 'x',
  brandName: 'Abilify',
  genericName: 'aripiprazole',
  provinces: allProvinces,
  ...over,
})

const catalogs: readonly SponsorCatalog[] = [
  { sponsor: 'innovicares', drugs: [drug({ url: 'https://example.test/abilify' })] },
  { sponsor: 'rxhelp', drugs: [] },
]

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
    render(<MedicationsView medications={medications} province="ON" catalogs={catalogs} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('Newer active')
    expect(rows[1]?.textContent).toContain('Older active')
    expect(rows[2]?.textContent).toContain('Undated active')
    expect(rows[3]?.textContent).toContain('Completed')
  })

  test('shows a green "Eligible" chip linking to coverage on eligible rows only', () => {
    const medications: readonly MedicationView[] = [
      view({ id: '1', displayName: 'Abilify 5 mg', status: 'active' }),
      view({ id: '2', displayName: 'ibuprofen', status: 'active' }),
    ]
    render(<MedicationsView medications={medications} province="ON" catalogs={catalogs} />)

    const rows = screen.getAllByRole('listitem')
    const abilifyRow = rows.find((row) => row.textContent?.includes('Abilify 5 mg'))
    const ibuprofenRow = rows.find((row) => row.textContent?.includes('ibuprofen'))

    // The whole chip is the coverage link, labelled "<program> Eligible".
    expect(abilifyRow).toBeDefined()
    if (abilifyRow !== undefined) {
      const chip = within(abilifyRow).getByRole('link', { name: 'innoviCares Eligible' })
      expect(chip.getAttribute('href')).toBe('https://example.test/abilify')
    }
    // The unmatched medication gets no chip.
    expect(ibuprofenRow).toBeDefined()
    if (ibuprofenRow !== undefined) {
      expect(within(ibuprofenRow).queryByText('innoviCares Eligible')).toBeNull()
    }
    // No "not sponsored" affordance anywhere.
    expect(screen.queryByText(/not sponsored/i)).toBeNull()
  })

  test('renders DIN, description, prescriber, notes and a combined repeats summary', () => {
    const medications: readonly MedicationView[] = [
      view(
        { id: '1', displayName: 'Atorvastatin', status: 'active' },
        {
          din: '02241497',
          description: '20 mg - Tablet',
          requester: 'Dr. Jane Smith',
          note: 'Take with food',
          repeatsAllowed: 3,
          repeatsAvailable: 2,
        }
      ),
    ]
    render(<MedicationsView medications={medications} province="ON" catalogs={catalogs} />)

    expect(screen.getByText('DIN 02241497')).toBeDefined()
    expect(screen.getByText('20 mg - Tablet')).toBeDefined()
    expect(screen.getByText('Dr. Jane Smith')).toBeDefined()
    expect(screen.getByText('Take with food')).toBeDefined()
    expect(screen.getByText('2 / 3 Repeats Available')).toBeDefined()
  })

  test('combined repeats reads "0 / 3" when none remain and "No Repeats" when none allowed', () => {
    const medications: readonly MedicationView[] = [
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
    render(<MedicationsView medications={medications} province="ON" catalogs={catalogs} />)

    expect(screen.getByText('0 / 3 Repeats Available')).toBeDefined()
    expect(screen.getAllByText('No Repeats')).toHaveLength(2)
  })

  test('renders the estimated next-fill day with a relative hint', () => {
    const medications: readonly MedicationView[] = [
      view({ id: '1', displayName: 'Atorvastatin' }, { nextFillDate: '2026-06-30T00:00:00.000Z' }),
    ]
    render(<MedicationsView medications={medications} province="ON" catalogs={catalogs} />)

    expect(screen.getByText('Next fill')).toBeDefined()
    // The absolute day is stable regardless of "now"; the relative hint is
    // covered deterministically by describeDayFromNow's own unit tests.
    const fill = screen.getByText('Next fill').nextElementSibling
    expect(fill?.textContent).toContain('2026-06-30')
  })

  test('renders a Rexall store link only when the request carries a store URL', () => {
    const medications: readonly MedicationView[] = [
      view(
        { id: 'rexall', displayName: 'From Rexall' },
        { rexallStoreUrl: 'https://www.rexall.ca/storelocator/store/8174' }
      ),
      view({ id: 'other', displayName: 'From elsewhere' }),
    ]
    render(<MedicationsView medications={medications} province="ON" catalogs={catalogs} />)

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

  test('renders an empty state when there are no medications', () => {
    render(<MedicationsView medications={[]} province="ON" catalogs={catalogs} />)
    expect(screen.getByText('No medications found.')).toBeDefined()
  })
})
