import { cleanup, render, screen } from '@testing-library/react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  Buckets,
  type LevelSeries,
  type PointSeries,
  ValueAxis,
} from '@wildflowerhealthio/health-viewer-fundamentals'

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

const renderRow = (
  axes: readonly ValueAxis.ValueAxis[],
  time: DateTime.Utc,
  bucketsBySeriesId: ReadonlyMap<string, readonly Buckets.Bucket[]> = new Map()
): string => {
  render(
    <CrosshairTooltip
      axes={axes}
      colours={[0]}
      bucketsBySeriesId={bucketsBySeriesId}
      time={time}
      left={0}
      flip={false}
    />
  )
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

  describe('on a bucketed series', () => {
    const dense: PointSeries.PointSeries = {
      kind: 'points',
      id: 'p:dense',
      label: 'Heart rate',
      unit: 'beats/min',
      valueScale: 'fitted',
      interpolation: 'linear',
      points: [
        { time: DateTime.unsafeMake(1 * DAY), value: 58 },
        { time: DateTime.unsafeMake(2 * DAY), value: 91 },
        { time: DateTime.unsafeMake(3 * DAY), value: 70.5 },
        { time: DateTime.unsafeMake(12 * DAY), value: 64 },
      ],
    }
    // Ten-day buckets: days 1–3 share the first, day 12 sits alone in the second.
    const buckets = Buckets.of(
      dense.points,
      [DateTime.unsafeMake(0), DateTime.unsafeMake(30 * DAY - 1)],
      3
    )
    const rowAt = (day: number): string =>
      renderRow(
        ValueAxis.assign([dense]),
        DateTime.unsafeMake(day * DAY),
        new Map([[dense.id, buckets]])
      )

    test('shows the bucket mean in the unit, and how many readings it is the mean of and their range', () => {
      const row = rowAt(5)
      expect(row).toContain(`${formatReading((58 + 91 + 70.5) / 3)} beats/min`)
      expect(row).toContain(`mean of 3 readings, ${formatReading(58)}–${formatReading(91)}`)
    })

    test('a bucket of one reading says so, without a range', () => {
      const row = rowAt(15)
      expect(row).toContain(`${formatReading(64)} beats/min`)
      expect(row).toContain('1 reading')
      expect(row).not.toContain('mean of')
    })

    test('a slice with no readings reads as a gap', () => {
      const row = rowAt(25)
      expect(row).toContain('—')
      expect(row).not.toContain('reading')
    })
  })
})
