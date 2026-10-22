import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { ColourSlots, LevelSeries, PointSeries } from '@wildflowerhealthio/plots-fundamentals'

import { ScatterChart } from './scatter-chart.tsx'
import { atDay, testWindow } from './series-arbitraries.test-helpers.ts'
import { seriesColors } from './series-colors.ts'

afterEach(cleanup)

const glucose: PointSeries.PointSeries = {
  kind: 'points',
  id: 'glucose',
  label: 'Glucose',
  unit: 'mmol/L',
  valueScale: 'fitted',
  interpolation: 'linear',
  points: [
    { time: atDay(10), value: 5 },
    { time: atDay(30), value: 7 },
    { time: atDay(50), value: 9 },
  ],
}

const insulin: LevelSeries.LevelSeries = {
  kind: 'levels',
  id: 'insulin',
  label: 'Insulin',
  unit: 'U',
  valueScale: 'from-zero',
  levels: [
    { start: atDay(0), end: atDay(20), value: 10, lineStyle: 'solid' },
    { start: atDay(40), end: null, value: 20, lineStyle: 'solid' },
  ],
}

/** The kept colours, X on a slot other than the first, as after an earlier series was deselected. */
const colours: ColourSlots.ColourSlots = new Map([
  ['insulin', 0],
  ['glucose', 2],
])

/** The figure's dots. */
const dots = (container: HTMLElement): readonly Element[] => [
  ...container.querySelectorAll('svg g[aria-label="dot"] circle'),
]

describe('ScatterChart', () => {
  it('should draw a dot per paired reading, label each axis with its unit, and count the unpaired', () => {
    // Act
    const { container } = render(
      <ScatterChart x={glucose} y={insulin} timeWindow={testWindow} colours={colours} />
    )

    // Assert
    expect(dots(container)).toHaveLength(2)
    const axisLabels = [...container.querySelectorAll('svg g[aria-label$="label"] text')].map(
      (label) => label.textContent
    )
    expect(axisLabels).toEqual(expect.arrayContaining(['Glucose (mmol/L)', 'Insulin (U)']))
    expect(screen.getByText('1 Glucose reading has no Insulin value at its time')).toBeDefined()
  })

  it('should paint the dots in the colour X keeps', () => {
    // Act
    const { container } = render(
      <ScatterChart x={glucose} y={insulin} timeWindow={testWindow} colours={colours} />
    )

    // Assert
    expect(container.querySelector('svg g[aria-label="dot"]')?.getAttribute('fill')).toBe(
      seriesColors(2).mark
    )
  })

  it('should keep to the window, and say when it holds no X reading', () => {
    // Act
    const { container, rerender } = render(
      <ScatterChart x={glucose} y={insulin} timeWindow={[atDay(45), atDay(60)]} colours={colours} />
    )

    // Assert
    expect(dots(container)).toHaveLength(1)

    // Act
    rerender(
      <ScatterChart x={glucose} y={insulin} timeWindow={[atDay(60), atDay(70)]} colours={colours} />
    )

    // Assert
    expect(dots(container)).toHaveLength(0)
    expect(screen.getByText('No Glucose readings in this range')).toBeDefined()
  })
})
