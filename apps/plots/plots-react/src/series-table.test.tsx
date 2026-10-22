import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { LevelSeries, PointSeries, SpanSeries } from '@wildflowerhealthio/plots-fundamentals'

import { atDay, testWindow } from './series-arbitraries.test-helpers.ts'
import { SeriesTable } from './series-table.tsx'
import { formatDateTime } from './value-format.ts'

afterEach(cleanup)

const glucose: PointSeries.PointSeries = {
  kind: 'points',
  id: 'glucose',
  label: 'Glucose',
  unit: 'mmol/L',
  valueScale: 'fitted',
  interpolation: 'linear',
  points: [
    { time: atDay(10), value: 5.4 },
    { time: atDay(30), value: 6.15 },
  ],
}

const insulin: LevelSeries.LevelSeries = {
  kind: 'levels',
  id: 'insulin',
  label: 'Insulin',
  unit: 'U',
  valueScale: 'from-zero',
  levels: [{ start: atDay(20), end: null, value: 10, note: 'per day', lineStyle: 'solid' }],
}

const sleep: SpanSeries.SpanSeries = {
  kind: 'spans',
  id: 'sleep',
  label: 'Sleep',
  spans: [
    {
      start: atDay(20),
      end: atDay(30),
      category: { id: 'asleep', label: 'Asleep', colourSlot: 0 },
    },
  ],
}

/** Each row's cells' text, the row header first. */
const rowTexts = (): readonly (readonly string[])[] =>
  within(screen.getByRole('table', { name: 'Readings' }))
    .getAllByRole('row')
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))

describe('SeriesTable', () => {
  it('should head a column per series with its unit, and list rows newest first with blanks', () => {
    // Act
    render(<SeriesTable series={[glucose, insulin, sleep]} timeWindow={testWindow} />)

    // Assert
    expect(rowTexts()).toEqual([
      ['Time', 'Glucose (mmol/L)', 'Insulin (U)', 'Sleep'],
      [formatDateTime(atDay(30)), '6.15', '', 'Asleep ends'],
      [formatDateTime(atDay(20)), '', '10 per day', 'Asleep starts'],
      [formatDateTime(atDay(10)), '5.4', '', ''],
    ])
  })

  it('should keep to the window it is given', () => {
    // Act
    render(<SeriesTable series={[glucose]} timeWindow={[atDay(20), atDay(40)]} />)

    // Assert
    expect(rowTexts()).toEqual([
      ['Time', 'Glucose (mmol/L)'],
      [formatDateTime(atDay(30)), '6.15'],
    ])
  })

  it('should say when the window holds nothing, and when nothing is selected', () => {
    // Act
    const { rerender } = render(
      <SeriesTable series={[glucose]} timeWindow={[atDay(40), atDay(50)]} />
    )

    // Assert
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('Nothing recorded in this range')).toBeDefined()

    // Act
    rerender(<SeriesTable series={[]} timeWindow={testWindow} />)

    // Assert
    expect(screen.getByText('Pick up to four series')).toBeDefined()
  })
})
