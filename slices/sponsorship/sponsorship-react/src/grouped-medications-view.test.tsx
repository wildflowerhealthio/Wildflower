import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  allProvinces,
  type Medication,
  type SponsorCatalog,
  type SponsoredDrug,
} from 'sponsorship-core'

import { GroupedMedicationsView } from './grouped-medications-view.tsx'

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
  { sponsor: 'innovicares', drugs: [drug({})] },
  {
    sponsor: 'rxhelp',
    drugs: [
      drug({ sponsor: 'rxhelp', brandName: 'Actonel DR', genericName: 'risedronate sodium' }),
    ],
  },
]

const medications: readonly Medication[] = [
  { id: '1', displayName: 'Abilify 5 mg', status: 'active' },
  { id: '2', displayName: 'ibuprofen' },
]

describe('GroupedMedicationsView', () => {
  test('renders a section per sponsor plus a not-sponsored section, with counts', () => {
    render(<GroupedMedicationsView medications={medications} province="ON" catalogs={catalogs} />)
    // Heading accessible names include the trailing count chip.
    expect(screen.getByRole('heading', { name: /innoviCares\s*1/ })).toBeDefined()
    expect(screen.getByRole('heading', { name: /RxHelp\s*0/ })).toBeDefined()
    expect(screen.getByRole('heading', { name: /Not sponsored\s*1/ })).toBeDefined()
  })

  test('places matched and unmatched medications in the right sections', () => {
    render(<GroupedMedicationsView medications={medications} province="ON" catalogs={catalogs} />)
    // The matched medication and its sponsor card (brand) both render.
    expect(screen.getByText('Abilify 5 mg')).toBeDefined()
    expect(screen.getByText('Abilify')).toBeDefined()
    // The unmatched medication renders once, with no sponsor card.
    expect(screen.getByText('ibuprofen')).toBeDefined()
    expect(screen.queryByText('risedronate sodium')).toBeNull()
  })
})
