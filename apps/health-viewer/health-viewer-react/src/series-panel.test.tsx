import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { type CatalogGroup, type CatalogRow, matchesSearch } from 'health-viewer-core-js'
import { type Series, ValueAxis } from 'health-viewer-fundamentals'

import { SeriesPanel } from './series-panel.tsx'

afterEach(cleanup)

/** Each run renders and types, so the base is kept small, as in the repo's other UI property tests. */
const RUNS = numRunsFor({ base: 10 })

const DAY = 86_400_000

/** A catalogue row for a synthetic series spanning `firstDay`..`lastDay` since the epoch. */
const catalogRow = (
  id: string,
  label: string,
  unit: string,
  seriesKind: Series.Series['kind'],
  count: number,
  [firstDay, lastDay]: readonly [number, number]
): CatalogRow => ({
  id,
  label,
  unit,
  seriesKind,
  count,
  span: [DateTime.unsafeMake(firstDay * DAY), DateTime.unsafeMake(lastDay * DAY)],
})

/**
 * More series than `ValueAxis.CAP`, across two point-series groups and a
 * level-series group — the shape `groupForPanel` hands the panel. Ids are
 * opaque to the panel, so they are arbitrary here. No label is a prefix of
 * another, so a row can be told apart by how its text starts.
 */
const catalogGroups: readonly CatalogGroup[] = [
  {
    id: 'vitals',
    label: 'Vital signs',
    rows: [
      catalogRow('p:systolic', 'Systolic blood pressure', 'mm[Hg]', 'points', 2, [18_000, 18_400]),
      catalogRow('p:heart-rate', 'Heart rate', '/min', 'points', 1, [18_100, 18_100]),
    ],
  },
  {
    id: 'labs',
    label: 'Laboratory',
    rows: [
      catalogRow('p:glucose', 'Glucose', 'mg/dL', 'points', 3, [17_000, 19_000]),
      catalogRow('p:a1c', 'Hemoglobin A1c', '%', 'points', 2, [18_200, 18_900]),
      catalogRow('p:cholesterol', 'Cholesterol', 'mmol/L', 'points', 1, [18_300, 18_300]),
    ],
  },
  {
    id: 'doses',
    label: 'Medications',
    rows: [catalogRow('l:metformin', 'Metformin', 'mg', 'levels', 2, [0, 30])],
  },
]

const allRows: readonly CatalogRow[] = catalogGroups.flatMap((group) => group.rows)

/** Every series id, in catalogue order. */
const seriesIds: readonly string[] = allRows.map((row) => row.id)

const renderPanel = (
  selectedSeriesIds: readonly string[] = []
): { readonly onSelectionChange: ReturnType<typeof vi.fn> } => {
  const onSelectionChange = vi.fn()
  render(
    <SeriesPanel
      catalogGroups={catalogGroups}
      selectedSeriesIds={selectedSeriesIds}
      onSelectionChange={onSelectionChange}
    />
  )
  return { onSelectionChange }
}

/** A group's `<li>`, found by its disclosure toggle. */
const groupItem = (label: string): HTMLElement => {
  const toggle = screen.getByRole('button', { name: new RegExp(`^${label}`) })
  const item = toggle.closest('li')
  if (item === null) throw new Error(`No group item for ${label}`)
  return item
}

/**
 * The row `<li>`s under `container` — leaves only. A group `<li>` also has the
 * `listitem` role and contains its rows' labels, so rows are the items whose
 * *direct* child is the checkbox label.
 */
const rowItems = (container: HTMLElement): readonly HTMLElement[] =>
  within(container)
    .queryAllByRole('listitem')
    .filter((item) => item.querySelector(':scope > label') !== null)

const checkboxFor = (label: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: new RegExp(`^${label}`) })

const monthYearFormat = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })

describe('SeriesPanel', () => {
  it('should list every series under its group heading with the group size', () => {
    // Act
    renderPanel()

    // Assert
    for (const group of catalogGroups) {
      const item = groupItem(group.label)
      expect(within(item).getByRole('button').getAttribute('aria-expanded')).toBe('true')
      expect(within(item).getByRole('button').textContent).toContain(String(group.rows.length))
      expect(rowItems(item).map((row) => row.textContent)).toEqual(
        group.rows.map((row) => expect.stringMatching(new RegExp(`^${row.label}`)))
      )
    }
  })

  it("should show a row's unit, point count and the months it spans", () => {
    // Act
    renderPanel()

    // Assert
    const text = checkboxFor('Glucose').closest('label')?.textContent ?? ''
    expect(text).toContain('mg/dL')
    expect(text).toContain('3 readings')
    expect(text).toContain(monthYearFormat.format(new Date(17_000 * DAY)))
    expect(text).toContain(monthYearFormat.format(new Date(19_000 * DAY)))
  })

  it('should count periods, not readings, on a level-series row', () => {
    // Act
    renderPanel()

    // Assert
    expect(checkboxFor('Metformin').closest('label')?.textContent).toContain('2 periods')
  })

  it('should show exactly the rows matchesSearch accepts, in catalogue order', async () => {
    const searchQueryArb = fc.oneof(
      fc.constantFrom('', 'glu', 'MG', 'a1c', 'blood pressure', 'pressure blood', 'mmol', 'zzz'),
      fc.stringMatching(/^[a-z0-9 ]{1,3}$/)
    )
    await fc.assert(
      fc.asyncProperty(searchQueryArb, async (typedQuery) => {
        // Arrange: no inter-key delay, so a run costs one render, not one timer per key.
        const user = userEvent.setup({ delay: null })
        const { container } = render(
          <SeriesPanel
            catalogGroups={catalogGroups}
            selectedSeriesIds={[]}
            onSelectionChange={vi.fn()}
          />
        )

        // A failing run must still unmount, or fast-check's shrink runs find two panels.
        try {
          // Act
          if (typedQuery !== '') await user.type(screen.getByLabelText('Search series'), typedQuery)

          // Assert
          const expectedRows = allRows.filter((row) => matchesSearch(row, typedQuery))
          const shownRowItems = rowItems(container)
          expect(shownRowItems).toHaveLength(expectedRows.length)
          expectedRows.forEach((row, index) => {
            expect(shownRowItems[index]?.textContent?.startsWith(row.label)).toBe(true)
          })
        } finally {
          cleanup()
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should say when nothing matches, and count matches against group size while searching', async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel()
    const laboratory = catalogGroups.find((group) => group.id === 'labs')
    const matching = laboratory?.rows.filter((row) => matchesSearch(row, 'mg')) ?? []

    // Act
    await user.type(screen.getByLabelText('Search series'), 'mg')

    // Assert
    expect(within(groupItem('Laboratory')).getByRole('button').textContent).toContain(
      `${matching.length} of ${laboratory?.rows.length}`
    )

    // Act
    await user.clear(screen.getByLabelText('Search series'))
    await user.type(screen.getByLabelText('Search series'), 'zzz')

    // Assert
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByText('No series match “zzz”.')).toBeDefined()
  })

  it('should append a checked row to the selection, keeping its order', async () => {
    // Arrange
    const user = userEvent.setup()
    const selectedSeriesIds = ['p:a1c', 'p:systolic']
    const { onSelectionChange } = renderPanel(selectedSeriesIds)

    // Act
    await user.click(checkboxFor('Metformin'))

    // Assert
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([...selectedSeriesIds, 'l:metformin'])
  })

  it('should remove an unchecked row from the selection, keeping the rest in order', async () => {
    // Arrange
    const user = userEvent.setup()
    const { onSelectionChange } = renderPanel(['p:systolic', 'p:heart-rate', 'p:glucose'])

    // Act
    await user.click(checkboxFor('Heart rate'))

    // Assert
    expect(checkboxFor('Heart rate').checked).toBe(true)
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(['p:systolic', 'p:glucose'])
  })

  it('should disable only the unchecked rows, with a hint, once the cap is reached', () => {
    // Arrange
    const selectedSeriesIds = seriesIds.slice(0, ValueAxis.CAP)

    // Act
    renderPanel(selectedSeriesIds)

    // Assert
    for (const [index, row] of allRows.entries()) {
      const checkbox = checkboxFor(row.label)
      expect(checkbox.checked).toBe(index < ValueAxis.CAP)
      expect(checkbox.disabled).toBe(index >= ValueAxis.CAP)
    }
    expect(screen.getByRole('status').textContent).toBe(`Up to ${ValueAxis.CAP} series at once`)
  })

  it('should leave every row enabled and show no hint below the cap', () => {
    // Act
    renderPanel(seriesIds.slice(0, ValueAxis.CAP - 1))

    // Assert
    for (const checkbox of screen.getAllByRole<HTMLInputElement>('checkbox')) {
      expect(checkbox.disabled).toBe(false)
    }
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('should fold and unfold a group from its heading', async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel()
    const laboratory = groupItem('Laboratory')
    const toggle = within(laboratory).getByRole('button')

    // Act
    await user.click(toggle)

    // Assert
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rowItems(laboratory)).toHaveLength(0)
    expect(rowItems(groupItem('Vital signs')).length).toBeGreaterThan(0)

    // Act
    await user.click(toggle)

    // Assert
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(rowItems(laboratory)).toHaveLength(
      catalogGroups.find((group) => group.id === 'labs')?.rows.length ?? -1
    )
  })

  it('should clear the whole selection, and offer nothing to clear when empty', async () => {
    // Arrange
    const user = userEvent.setup()
    const { onSelectionChange } = renderPanel(seriesIds.slice(0, 2))

    // Act
    await user.click(screen.getByRole('button', { name: 'Clear' }))

    // Assert
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([])
    cleanup()
    renderPanel([])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear' }).disabled).toBe(true)
  })

  it('should say so when the record has no plottable series', () => {
    // Act
    render(<SeriesPanel catalogGroups={[]} selectedSeriesIds={[]} onSelectionChange={vi.fn()} />)

    // Assert
    expect(screen.getByText('No plottable series in this record.')).toBeDefined()
  })
})
