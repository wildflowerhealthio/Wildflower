import { cleanup, render } from '@testing-library/react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { type PointSeries, ValueAxis } from '@wildflowerhealthio/health-viewer-fundamentals'

import { Legend } from './legend.tsx'
import { seriesColors } from './series-colors.ts'

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
  test('lists every series in order, keyed in its series colour, with text outside it', () => {
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
          const axes = ValueAxis.assign(
            entries.map(({ label, unit }, index) => seriesNamed(label, unit, index))
          )
          const { container } = render(
            <Legend axes={axes} colours={axes.map((_, position) => position)} />
          )
          // Structural query rather than `getAllByRole`: role queries are slow
          // enough in jsdom to time a property test out.
          const items = [...container.querySelectorAll('ul[aria-label="Series"] > li')]
          expect(items).toHaveLength(axes.length)
          items.forEach((item, position) => {
            const { label, unit } = entries[position]
            expect(item.textContent).toContain(unit === null ? label : `${label} (${unit})`)
            const key = item.querySelector('[aria-hidden="true"]')
            expect(key?.getAttribute('style')).toContain(seriesColors(position).mark)
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
