import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { decodeDdinterFile, type OtcCategory } from 'medication-interaction-core'
import type { Medication } from 'medication-matching-core'

import { InteractionsView } from './interactions-view.tsx'

afterEach(cleanup)

describe('InteractionsView', () => {
  it('should start with every group collapsed and summarise each section beside its heading', () => {
    // Arrange
    const medications = [med('1', 'Warfarin 5 mg tablet'), med('2', 'Ibuprofen 200 mg')]

    // Act
    render(<InteractionsView medications={medications} catalog={catalog} otc={otc} />)

    // Assert
    const section = sectionNamed('Between your medications')
    expect(section.textContent).toContain('2 of your medications · 1 potential interaction')
    const headers = within(section).getAllByRole('button')
    expect(headers.map((header) => header.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
    ])
    expect(within(section).queryByRole('link')).toBeNull()
    expect(sectionNamed('With common over-the-counter drugs').textContent).toContain(
      '1 category · 3 potential interactions'
    )
  })

  it('should show a group of medications named for the far side, worst first, when opened', async () => {
    // Arrange
    const user = userEvent.setup()
    render(
      <InteractionsView
        medications={[med('1', 'Warfarin 5 mg tablet'), med('2', 'Ibuprofen 200 mg')]}
        catalog={catalog}
        otc={otc}
      />
    )
    const section = sectionNamed('Between your medications')
    const warfarin = within(section).getByRole('button', { name: /Warfarin 5 mg tablet/ })

    // Act
    await user.click(warfarin)

    // Assert
    expect(warfarin.getAttribute('aria-expanded')).toBe('true')
    const rows = within(section)
      .getAllByRole('listitem')
      .filter((item) => item.querySelector(':scope > a'))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.textContent).toContain('Ibuprofen 200 mg')
    // The group's own medication is not repeated in its rows.
    expect(row?.textContent).not.toContain('Warfarin')
    expect(within(row ?? section).getByRole('status').textContent).toContain('Major')
    const link = within(row ?? section).getByRole('link', { name: /Details for Ibuprofen/ })
    expect(link.getAttribute('href')).toContain('DDInter2')
  })

  it('should nest OTC actives, with their brands, inside their category', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)
    const section = sectionNamed('With common over-the-counter drugs')

    // Act
    await user.click(within(section).getByRole('button', { name: /^Pain/ }))

    // Assert: the actives appear, most severe first, still collapsed.
    const actives = within(section).getAllByRole('button', { expanded: false })
    expect(actives.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Aspirin'),
      expect.stringContaining('Acetaminophen'),
    ])
    expect(actives[0]?.textContent).toContain('Aspirin, ASA')
    expect(actives[0]?.textContent).toContain('1 of your medications')
    expect(within(section).queryByRole('link')).toBeNull()

    // Act: open an active.
    await user.click(actives[0] ?? section)

    // Assert
    expect(within(section).getByRole('link', { name: /Details for Warfarin/ })).toBeDefined()
  })

  it('should keep an active open when its category is collapsed and reopened', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)
    const section = sectionNamed('With common over-the-counter drugs')
    const category = within(section).getByRole('button', { name: /^Pain/ })
    await user.click(category)
    await user.click(within(section).getByRole('button', { name: /Aspirin/ }))

    // Act
    await user.click(category)
    expect(within(section).queryByRole('link')).toBeNull()
    await user.click(category)

    // Assert
    expect(
      within(section)
        .getByRole('button', { name: /Aspirin/ })
        .getAttribute('aria-expanded')
    ).toBe('true')
    expect(within(section).getByRole('link', { name: /Details for Warfarin/ })).toBeDefined()
  })

  it('should list non-drug interactions when the catalog carries non-drug entries', async () => {
    const user = userEvent.setup()
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)

    const section = sectionNamed('With food, alcohol and other non-drugs')
    expect(section.textContent).toContain('1 non-drug · 1 potential interaction')
    await user.click(within(section).getByRole('button', { name: /Caffeine/ }))
    expect(within(section).getByRole('status').textContent).toContain('Minor')
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

  it('should show the severity legend and attribute the data to its source', () => {
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)

    expect(screen.getByText('Severity').parentElement?.textContent).toBe(
      'SeverityMajorModerateMinorUnknown'
    )
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
    [1, 2, 1],
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

const otc: readonly OtcCategory[] = [
  {
    name: 'Pain',
    drugs: [{ name: 'Aspirin', brands: 'Aspirin, ASA' }, { name: 'Acetaminophen' }],
  },
  { name: 'Allergy', drugs: [{ name: 'Loratadine' }] },
]

const med = (id: string, displayName: string): Medication => ({ id, displayName })

/** The `<section>` owning the heading with this text. */
const sectionNamed = (title: string): HTMLElement => {
  const section = screen.getByRole('heading', { name: title }).closest('section')
  if (section === null) throw new Error(`no section for "${title}"`)
  return section
}
