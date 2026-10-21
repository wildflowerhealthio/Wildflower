import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  levelFrom,
  levelSeriesOf,
  pointSeriesOf,
  seriesArb,
  windowArb,
} from './arbitraries.test-helpers.ts'
import { Scatter, Series, TimeDomain } from './index.ts'

const RUNS = numRunsFor({ base: 200 })

describe('Scatter.of', () => {
  test('pairs every X reading in the window with Y’s level there, or counts it unpaired', () => {
    fc.assert(
      fc.property(seriesArb, seriesArb, windowArb, (x, y, window) => {
        const inWindow = Series.levelsOf(x).filter((level) =>
          TimeDomain.contains(window, level.start.epochMillis)
        )
        const read = inWindow.map((level) => ({
          time: level.start,
          x: level,
          y: Series.levelAt(y, level.start),
        }))
        const scatter = Scatter.of(x, y, window)
        expect(scatter.pairs).toEqual(read.filter((pair) => pair.y !== null))
        expect(scatter.unpairedCount).toBe(read.filter((pair) => pair.y === null).length)
      }),
      { numRuns: RUNS }
    )
  })

  test('reads Y as the crosshair does: before its first reading, and not in a dose gap', () => {
    const glucose = pointSeriesOf([
      { time: DateTime.unsafeMake(100), value: 5 },
      { time: DateTime.unsafeMake(300), value: 7 },
      { time: DateTime.unsafeMake(500), value: 9 },
    ])
    const dose = levelSeriesOf([levelFrom(0, 200, 10), levelFrom(400, null, 20)])
    const weight = pointSeriesOf([{ time: DateTime.unsafeMake(200), value: 80 }])
    const window: TimeDomain.TimeDomain = [DateTime.unsafeMake(0), DateTime.unsafeMake(1000)]

    const againstDose = Scatter.of(glucose, dose, window)
    expect(againstDose.pairs.map((pair) => [pair.x.value, pair.y.value])).toEqual([
      [5, 10],
      [9, 20],
    ])
    expect(againstDose.unpairedCount).toBe(1)

    expect(
      Scatter.of(glucose, weight, window).pairs.map((pair) => [pair.x.value, pair.y.value])
    ).toEqual([
      [5, 80],
      [7, 80],
      [9, 80],
    ])
  })
})
