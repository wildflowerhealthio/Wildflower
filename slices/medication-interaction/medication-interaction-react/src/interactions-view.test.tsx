import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { decodeDdinterFile } from 'medication-interaction-core'
import type { Medication } from 'medication-matching-core'

import { InteractionsView } from './interactions-view.tsx'

afterEach(cleanup)

describe('InteractionsView', () => {
  it('should list interactions between the medications with severity, names and a details link', () => {
    // Arrange
    const medications = [med('1', 'Warfarin 5 mg tablet'), med('2', 'Ibuprofen 200 mg')]

    // Act
    render(<InteractionsView medications={medications} catalog={catalog} otc={otc} />)

    // Assert
    const section = sectionNamed('Between your medications')
    const rows = within(section).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(within(row).getByRole('status').textContent).toContain('Major')
    expect(row.textContent).toContain('Ibuprofen')
    expect(row.textContent).toContain('Warfarin')
    // The prescribed names differ from the DDInter names, so both are shown.
    expect(row.textContent).toContain('Warfarin 5 mg tablet')
    expect(row.textContent).toContain('Ibuprofen 200 mg')
    const link = within(row).getByRole('link', { name: 'Details' })
    expect(link.getAttribute('href')).toContain('ddinter.scbdd.com')
  })

  it('should list OTC interactions with the familiar brands under the OTC side', () => {
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)

    const section = sectionNamed('With common over-the-counter drugs')
    const rows = within(section).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Aspirin'),
      expect.stringContaining('Acetaminophen'),
    ])
    expect(rows[0]?.textContent).toContain('Aspirin, ASA')
    // A medication named exactly as DDInter names it is not repeated underneath.
    expect(rows[0]?.textContent?.match(/Warfarin/g)).toHaveLength(1)
  })

  it('should list non-drug interactions when the catalog carries non-drug entries', () => {
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)

    const section = sectionNamed('With food, alcohol and other non-drugs')
    expect(within(section).getAllByRole('listitem')).toHaveLength(1)
    expect(section.textContent).toContain('Caffeine')
  })

  it('should explain an empty non-drug section when the catalog has no non-drug entries', () => {
    render(
      <InteractionsView medications={[med('1', 'Warfarin')]} catalog={drugOnlyCatalog} otc={otc} />
    )

    const section = sectionNamed('With food, alcohol and other non-drugs')
    expect(section.textContent).toContain('DDInter lists drug–drug interactions only')
    expect(within(section).queryByRole('list')).toBeNull()
  })

  it('should show a "none listed" line for an empty section', () => {
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)

    const section = sectionNamed('Between your medications')
    expect(section.textContent).toContain('No interactions listed between your medications.')
  })

  it('should attribute the data and link to the source', () => {
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)

    const source = screen.getByRole('link', { name: 'DDInter' })
    expect(source.getAttribute('href')).toBe('https://ddinter.scbdd.com/')
  })

  it('should render an empty state when there are no medications', () => {
    render(<InteractionsView medications={[]} catalog={catalog} otc={otc} />)
    expect(screen.getByText('No medications to check.')).toBeDefined()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('should render a notice instead of sections when no database is bundled', () => {
    render(
      <InteractionsView medications={[med('1', 'Warfarin')]} catalog={emptyCatalog} otc={otc} />
    )
    expect(screen.getByText(/No interaction database is bundled/)).toBeDefined()
    expect(screen.queryByRole('heading')).toBeNull()
  })
})

// Helpers

const source = { name: 'DDInter', url: 'https://ddinter.scbdd.com/' }

const emptyCatalog = decodeDdinterFile({ source, drugs: [], pairs: [] })

// Indexes: 0 Warfarin, 1 Ibuprofen, 2 Aspirin, 3 Caffeine, 4 Acetaminophen.
const catalog = decodeDdinterFile({
  source,
  drugs: [
    ['DDInter1', 'Warfarin'],
    ['DDInter2', 'Ibuprofen'],
    ['DDInter3', 'Aspirin'],
    ['DDInter4', 'Caffeine'],
    ['DDInter5', 'Acetaminophen'],
  ],
  pairs: [
    [0, 1, 0],
    [0, 2, 0],
    [0, 3, 2],
    [0, 4, 1],
  ],
})

const drugOnlyCatalog = decodeDdinterFile({
  source,
  drugs: [
    ['DDInter1', 'Warfarin'],
    ['DDInter2', 'Ibuprofen'],
  ],
  pairs: [[0, 1, 0]],
})

const otc = [{ name: 'Aspirin', brands: 'Aspirin, ASA' }, { name: 'Acetaminophen' }]

const med = (id: string, displayName: string): Medication => ({ id, displayName })

/** The `<section>` owning the heading with this text. */
const sectionNamed = (title: string): HTMLElement => {
  const section = screen.getByRole('heading', { name: title }).closest('section')
  if (section === null) throw new Error(`no section for "${title}"`)
  return section
}
