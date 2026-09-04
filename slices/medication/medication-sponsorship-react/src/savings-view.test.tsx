import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { Medication, SponsorCatalog, SponsoredDrug } from 'medication-sponsorship-core'

import { SavingsView } from './savings-view.tsx'

afterEach(() => {
  cleanup()
})

describe('SavingsView', () => {
  it('lists a covered medication under its program with the eligibility chip', () => {
    renderSavings({ province: 'ON' })

    const section = screen.getByRole('heading', { name: 'innoviCares' }).closest('section')
    expect(section?.textContent).toContain('Jardiance')
    expect(section?.textContent).toContain('innoviCares Eligible')
  })

  it('describes each program with a link to its site', () => {
    renderSavings({ province: 'ON' })

    expect(screen.getByText(/free prescription savings card/)).toBeDefined()
    const link = screen.getByRole('link', { name: /innovicares\.ca/ })
    expect(link.getAttribute('href')).toBe('https://innovicares.ca')
  })

  it('puts a medication covered only in another province under "No known savings program"', () => {
    renderSavings({ province: 'BC' })

    const uncovered = screen
      .getByRole('heading', { name: 'No known savings program' })
      .closest('section')
    expect(uncovered?.textContent).toContain('Jardiance')
    const sponsored = screen.getByRole('heading', { name: 'innoviCares' }).closest('section')
    expect(sponsored?.textContent).toContain('None of your medications are covered')
  })

  it('lists an unmatched medication under "No known savings program"', () => {
    renderSavings({ province: 'ON' })

    const uncovered = screen
      .getByRole('heading', { name: 'No known savings program' })
      .closest('section')
    expect(uncovered?.textContent).toContain('Home-made tincture')
  })

  it('re-groups when the province changes', () => {
    const onProvinceChange = vi.fn()
    renderSavings({ province: 'ON', onProvinceChange })

    fireEvent.change(screen.getByRole('combobox', { name: 'Province' }), {
      target: { value: 'BC' },
    })

    expect(onProvinceChange).toHaveBeenCalledWith('BC')
  })
})

// Helpers

const medication = (id: string, displayName: string): Medication => ({
  id,
  displayName,
  status: 'active',
  authoredOn: '2026-08-01T00:00:00Z',
})

/** Covered in Ontario only, so BC re-buckets it as uncovered. */
const jardiance: SponsoredDrug = {
  sponsor: 'innovicares',
  id: 'jardiance',
  brandName: 'Jardiance',
  genericName: 'empagliflozin',
  provinces: ['ON'],
  url: 'https://innovicares.ca/jardiance',
}

const catalogs: readonly SponsorCatalog[] = [
  { sponsor: 'innovicares', drugs: [jardiance] },
  { sponsor: 'rxhelp', drugs: [] },
]

const renderSavings = ({
  province,
  onProvinceChange = () => {},
}: {
  readonly province: 'ON' | 'BC'
  readonly onProvinceChange?: (province: string) => void
}): void => {
  render(
    <SavingsView
      medications={[medication('rx-1', 'Jardiance'), medication('rx-2', 'Home-made tincture')]}
      province={province}
      onProvinceChange={onProvinceChange}
      catalogs={catalogs}
    />
  )
}
