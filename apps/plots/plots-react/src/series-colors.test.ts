import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { SpanSeries, ValueAxis } from '@wildflowerhealthio/plots-fundamentals'

import { seriesColors, spanColour } from './series-colors.ts'

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

describe('spanColour', () => {
  test('gives each lane colour slot its own token, apart from the series slots', () => {
    const tokens = Array.from({ length: SpanSeries.COLOUR_SLOTS }, (_, slot) => spanColour(slot))
    expect(tokens).toEqual(
      Array.from({ length: SpanSeries.COLOUR_SLOTS }, (_, slot) => `var(--color-span-${slot + 1})`)
    )
    expect(spanColour(null)).not.toMatch(/--color-(series|span)-/)
  })

  test('never cycles past the validated lane colours', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: -1 }),
          fc.integer({ min: SpanSeries.COLOUR_SLOTS }),
          fc.double({ noInteger: true })
        ),
        (slot) => {
          expect(() => spanColour(slot)).toThrow()
        }
      ),
      { numRuns: RUNS }
    )
  })
})
