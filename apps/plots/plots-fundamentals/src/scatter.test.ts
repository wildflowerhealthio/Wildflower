import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  levelFrom,
  levelSeriesOf,
  pointSeriesArb,
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
        const firstYMillis = Series.levelsOf(y)[0]?.start.epochMillis ?? Infinity
        const read = inWindow.map((level) => ({
          time: level.start,
          x: level,
          y:
            y.kind === 'points' && level.start.epochMillis < firstYMillis
              ? null
              : Series.levelAt(y, level.start),
        }))
        const scatter = Scatter.of(x, y, window)
        expect(scatter.pairs).toEqual(read.filter((pair) => pair.y !== null))
        expect(scatter.unpairedCount).toBe(read.filter((pair) => pair.y === null).length)
      }),
      { numRuns: RUNS }
    )
  })

  test('counts an X reading before a point series Y’s first reading as unpaired', () => {
    fc.assert(
      fc.property(seriesArb, pointSeriesArb, windowArb, (x, y, window) => {
        const first = y.points[0]
        fc.pre(first !== undefined)
        const scatter = Scatter.of(x, y, window)
        for (const pair of scatter.pairs) {
          expect(pair.time.epochMillis).toBeGreaterThanOrEqual(first.time.epochMillis)
        }
        const before = Series.levelsOf(x).filter(
          (level) =>
            TimeDomain.contains(window, level.start.epochMillis) &&
            level.start.epochMillis < first.time.epochMillis
        )
        expect(scatter.unpairedCount).toBe(before.length)
      }),
      { numRuns: RUNS }
    )
  })

  test('holds a point series Y from its first reading on, and pairs nothing in a dose gap', () => {
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

    const againstWeight = Scatter.of(glucose, weight, window)
    expect(againstWeight.pairs.map((pair) => [pair.x.value, pair.y.value])).toEqual([
      [7, 80],
      [9, 80],
    ])
    expect(againstWeight.unpairedCount).toBe(1)
  })
})
