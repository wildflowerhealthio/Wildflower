import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { ValueAxis } from 'health-viewer-fundamentals'

import { seriesColors } from './series-colors.ts'

const RUNS = numRunsFor({ base: 100 })

describe('seriesColors', () => {
  test('gives each palette index a distinct categorical token and its own band', () => {
    const slots = Array.from({ length: ValueAxis.CAP }, (_, position) => seriesColors(position))
    expect(new Set(slots.map((colors) => colors.mark)).size).toBe(ValueAxis.CAP)
    slots.forEach((colors, position) => {
      expect(colors.mark).toBe(`var(--color-series-${position + 1})`)
      expect(colors.band).toBe(`var(--color-series-${position + 1}-soft)`)
    })
  })

  test('never cycles past the validated slots', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: -1 }),
          fc.integer({ min: ValueAxis.CAP }),
          fc.double({ noInteger: true })
        ),
        (position) => {
          expect(() => seriesColors(position)).toThrow()
        }
      ),
      { numRuns: RUNS }
    )
  })
})
