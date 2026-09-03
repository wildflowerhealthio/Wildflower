import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { Medication } from 'medication-core'
import { decodeDdinterFile, type OtcCategory } from 'medication-interaction-core'

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
    // Only the disclosure toggles carry aria-expanded; the pip buttons do not.
    const headers = within(section).getAllByRole('button', { expanded: false })
    expect(headers).toHaveLength(2)
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
    const warfarin = within(section).getByRole('button', {
      name: /Warfarin 5 mg tablet/,
      expanded: false,
    })

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

  it('should unfold the named nested active when its category pip is clicked', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)
    const section = sectionNamed('With common over-the-counter drugs')

    // Act: click the category's pip for Aspirin (category starts collapsed).
    await user.click(
      within(section).getByRole('button', { name: 'Aspirin (Aspirin, ASA) — Major' })
    )

    // Assert: the category and that specific active both opened, to its rows.
    expect(within(section).getByRole('button', { name: /Aspirin/, expanded: true })).toBeDefined()
    expect(within(section).getByRole('link', { name: /Details for Warfarin/ })).toBeDefined()
  })

  it('should keep an active open when its category is collapsed and reopened', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)
    const section = sectionNamed('With common over-the-counter drugs')
    const category = within(section).getByRole('button', { name: /^Pain/ })
    await user.click(category)
    await user.click(within(section).getByRole('button', { name: /Aspirin/, expanded: false }))

    // Act
    await user.click(category)
    expect(within(section).queryByRole('link')).toBeNull()
    await user.click(category)

    // Assert
    expect(
      within(section)
        .getByRole('button', { name: /Aspirin/, expanded: true })
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

  it('should name each header pip by the counterpart it stands for', () => {
    render(
      <InteractionsView
        medications={[med('1', 'Warfarin'), med('2', 'Ibuprofen')]}
        catalog={catalog}
        otc={otc}
      />
    )

    // Between: the Warfarin card's pip names the far-side medication and severity.
    const between = sectionNamed('Between your medications')
    expect(within(between).getByRole('button', { name: 'Ibuprofen — Major' })).toBeDefined()
    // OTC: a category pip names the active with its brand, at its worst severity.
    const otcSection = sectionNamed('With common over-the-counter drugs')
    expect(
      within(otcSection).getByRole('button', { name: 'Aspirin (Aspirin, ASA) — Major' })
    ).toBeDefined()
  })

  it('should reveal a pip tooltip only while hovered', async () => {
    const user = userEvent.setup()
    render(
      <InteractionsView
        medications={[med('1', 'Warfarin'), med('2', 'Ibuprofen')]}
        catalog={catalog}
        otc={otc}
      />
    )
    const between = sectionNamed('Between your medications')
    const pip = within(between).getByRole('button', { name: 'Ibuprofen — Major' })

    expect(within(pip).queryByText('Ibuprofen')).toBeNull()
    await user.hover(pip)
    expect(within(pip).getByText('Ibuprofen')).toBeDefined()
    await user.unhover(pip)
    expect(within(pip).queryByText('Ibuprofen')).toBeNull()
  })

  it('should not label non-drug rows with a medication count', () => {
    render(<InteractionsView medications={[med('1', 'Warfarin')]} catalog={catalog} otc={otc} />)
    const section = sectionNamed('With food, alcohol and other non-drugs')
    expect(section.textContent).not.toContain('of your medications')
  })

  it('should cap the pip strip and mark the remainder with "+N more"', () => {
    // A hub medication interacting with 13 others exceeds the 12-pip cap.
    const names = ['Interacterol', ...Array.from({ length: 13 }, (_, index) => `Spoke${index}`)]
    const hubCatalog = decodeDdinterFile({
      source,
      drugs: names.map((name, index): [string, string] => [`DDInter${index}`, name]),
      pairs: names.slice(1).map((_, index): [number, number, number] => [0, index + 1, 3]),
    })

    render(
      <InteractionsView
        medications={names.map((name, index) => med(String(index), name))}
        catalog={hubCatalog}
        otc={[]}
      />
    )

    const between = sectionNamed('Between your medications')
    const hubCard = within(between)
      .getByRole('button', { name: /Interacterol/, expanded: false })
      .closest('li')
    expect(hubCard?.textContent).toContain('+1 more')
    // Only the hub overflows; the 13 single-interaction spokes show no marker.
    expect(between.textContent?.match(/\+1 more/g)).toHaveLength(1)
  })

  it('should ring the avatar of an interaction between two different prescribers', async () => {
    const user = userEvent.setup()
    const prescribers = new Map([
      ['1', 'Alice Smith'],
      ['2', 'Bob Jones'],
    ])
    render(
      <InteractionsView
        medications={[med('1', 'Warfarin'), med('2', 'Ibuprofen')]}
        catalog={catalog}
        otc={otc}
        prescriberOf={(medication) => prescribers.get(medication.id) ?? null}
      />
    )

    const section = sectionNamed('Between your medications')
    await user.click(within(section).getByRole('button', { name: /Warfarin/, expanded: false }))

    // Warfarin (Alice) interacts with Ibuprofen (Bob) — a cross-prescriber row.
    expect(
      within(section).getByRole('img', { name: 'Dr. Bob Jones — different prescriber' })
    ).toBeDefined()
  })

  it('should not ring avatars when both medications share a prescriber', async () => {
    const user = userEvent.setup()
    render(
      <InteractionsView
        medications={[med('1', 'Warfarin'), med('2', 'Ibuprofen')]}
        catalog={catalog}
        otc={otc}
        prescriberOf={() => 'Alice Smith'}
      />
    )

    const section = sectionNamed('Between your medications')
    await user.click(within(section).getByRole('button', { name: /Warfarin/, expanded: false }))

    expect(within(section).queryByRole('img', { name: /different prescriber/ })).toBeNull()
    expect(within(section).getAllByRole('img', { name: 'Dr. Alice Smith' }).length).toBeGreaterThan(
      0
    )
  })

  it('should show prescriber avatars only in the between-medications section', async () => {
    const user = userEvent.setup()
    render(
      <InteractionsView
        medications={[med('1', 'Warfarin'), med('2', 'Ibuprofen')]}
        catalog={catalog}
        otc={otc}
        prescriberOf={() => 'Alice Smith'}
      />
    )

    const otcSection = sectionNamed('With common over-the-counter drugs')
    await user.click(within(otcSection).getByRole('button', { name: /^Pain/ }))
    await user.click(within(otcSection).getByRole('button', { name: /Aspirin/, expanded: false }))

    // No prescriber avatar (role img, label starts "Dr.") outside the between section.
    expect(within(otcSection).queryByRole('img', { name: /^Dr\./ })).toBeNull()
    const nonDrug = sectionNamed('With food, alcohol and other non-drugs')
    expect(within(nonDrug).queryByRole('img', { name: /^Dr\./ })).toBeNull()
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
