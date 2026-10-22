import { cleanup, render } from '@testing-library/react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { ColourSlots, type PointSeries, ValueAxis } from '@wildflowerhealthio/plots-fundamentals'

import { Legend } from './legend.tsx'
import { colourSlotOf, seriesColors } from './series-colors.ts'

afterEach(cleanup)

const RUNS = numRunsFor({ base: 50 })

const seriesNamed = (
  label: string,
  unit: string | null,
  index: number
): PointSeries.PointSeries => ({
  kind: 'points',
  id: `p:${index}`,
  label,
  unit,
  valueScale: 'fitted',
  interpolation: 'linear',
  points: [{ time: DateTime.unsafeMake(0), value: index }],
})

describe('Legend', () => {
  test('lists every series axis by axis, keyed in its series colour, with text outside it', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc
              .string({ minLength: 1, maxLength: 20 })
              .filter((s) => s.trim() === s && s !== ''),
            unit: fc.option(fc.constantFrom('mg/dL', 'mmol/L', '%'), { nil: null }),
          }),
          { minLength: 1, maxLength: ValueAxis.CAP }
        ),
        (entries) => {
          const selected = entries.map(({ label, unit }, index) => seriesNamed(label, unit, index))
          const axes = ValueAxis.assign(selected)
          const colours = ColourSlots.assign(
            new Map(),
            selected.map((series) => series.id)
          )
          const { container } = render(
            <Legend axes={axes} colours={colours} lanes={[]} laneCategories={[]} />
          )
          // Structural query rather than `getAllByRole`: role queries are slow
          // enough in jsdom to time a property test out.
          const items = [...container.querySelectorAll('ul[aria-label="Series"] > li')]
          const listed = axes.flatMap((axis) =>
            axis.series.map((series) => ({ series, side: axis.side }))
          )
          expect(items).toHaveLength(selected.length)
          items.forEach((item, position) => {
            const { series, side } = listed[position]
            const { label, unit } = series
            expect(item.textContent).toContain(unit === null ? label : `${label} (${unit})`)
            expect(item.textContent).toContain(`${side} axis`)
            const key = item.querySelector('[aria-hidden="true"]')
            expect(key?.getAttribute('style')).toContain(
              seriesColors(colourSlotOf(colours, series.id)).mark
            )
            // Only the key carries the series colour; the text never does.
            const coloured = [...item.querySelectorAll('[style]')]
            expect(coloured).toEqual([key])
          })
          cleanup()
        }
      ),
      { numRuns: RUNS }
    )
  })
})
