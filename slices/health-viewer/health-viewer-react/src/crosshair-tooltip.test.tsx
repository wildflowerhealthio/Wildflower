import { cleanup, render, screen } from '@testing-library/react'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { type LevelSeries, type PointSeries, ValueAxis } from 'health-viewer-fundamentals'

import { CrosshairTooltip } from './crosshair-tooltip.tsx'
import { formatDate, formatReading } from './value-format.ts'

afterEach(cleanup)

const RUNS = numRunsFor({ base: 50 })
const DAY = 86_400_000

const oneLevel = (
  value: number,
  note: string | null,
  endDay: number | null
): LevelSeries.LevelSeries => ({
  kind: 'levels',
  id: 'l:one',
  label: 'Level',
  unit: 'mg',
  valueScale: 'from-zero',
  levels: [
    {
      start: DateTime.unsafeMake(0),
      end: endDay === null ? null : DateTime.unsafeMake(endDay * DAY),
      value,
      lineStyle: 'solid',
      ...(note === null ? {} : { note }),
    },
  ],
})

const renderRow = (axes: readonly ValueAxis.ValueAxis[], time: DateTime.Utc): string => {
  render(<CrosshairTooltip axes={axes} colours={[0]} time={time} left={0} flip={false} />)
  return screen.getByTestId('crosshair-row').textContent ?? ''
}

describe('CrosshairTooltip', () => {
  test('shows a level’s value, unit and note, and the span it holds over', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.option(fc.constantFrom('per day', 'per week'), { nil: null }),
        fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }),
        (value, note, endDay) => {
          const series = oneLevel(value, note, endDay)
          const row = renderRow(ValueAxis.assign([series]), DateTime.unsafeMake(0))
          const shown = `${formatReading(value)} mg`
          expect(row).toContain(note === null ? shown : `${shown} ${note}`)
          expect(row).toContain(formatDate(series.levels[0].start))
          expect(row).toContain(
            endDay === null ? 'ongoing' : formatDate(DateTime.unsafeMake(endDay * DAY))
          )
          cleanup()
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('dates a point series’ value by the reading it holds, not a span', () => {
    const series: PointSeries.PointSeries = {
      kind: 'points',
      id: 'p:one',
      label: 'Reading',
      unit: 'mmol/L',
      valueScale: 'fitted',
      interpolation: 'linear',
      points: [
        { time: DateTime.unsafeMake(10 * DAY), value: 5.4 },
        { time: DateTime.unsafeMake(40 * DAY), value: 6.1 },
      ],
    }
    const row = renderRow(ValueAxis.assign([series]), DateTime.unsafeMake(25 * DAY))
    expect(row).toContain(`${formatReading(5.4)} mmol/L`)
    expect(row).toContain(formatDate(DateTime.unsafeMake(10 * DAY)))
    expect(row).not.toContain('–')
  })
})
