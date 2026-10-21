import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  anySeriesArb,
  levelFrom,
  levelSeriesOf,
  pointSeriesOf,
  spanFrom,
  spanSeriesOf,
  windowArb,
} from './arbitraries.test-helpers.ts'
import { ReadingTable, Series, TimeDomain } from './index.ts'

const RUNS = numRunsFor({ base: 200 })

/** The instants `series` has an entry at: level starts, or span starts and ends. */
const entryInstantsOf = (series: Series.Series): readonly number[] =>
  Series.isSpanSeries(series)
    ? series.spans.flatMap((span) => [span.start.epochMillis, span.end.epochMillis])
    : Series.levelsOf(series).map((level) => level.start.epochMillis)

const columnsArb = fc.array(anySeriesArb, { maxLength: 5 })

describe('ReadingTable.of', () => {
  test('keeps the columns and gives every row one cell per column', () => {
    fc.assert(
      fc.property(columnsArb, windowArb, (columns, window) => {
        const table = ReadingTable.of(columns, window)
        expect(table.columns).toBe(columns)
        for (const row of table.rows) expect(row.cells).toHaveLength(columns.length)
      }),
      { numRuns: RUNS }
    )
  })

  test('has a row for exactly the instants inside the window some column has an entry at, newest first', () => {
    fc.assert(
      fc.property(columnsArb, windowArb, (columns, window) => {
        const expected = [...new Set(columns.flatMap(entryInstantsOf))]
          .filter((millis) => TimeDomain.contains(window, millis))
          .toSorted((left, right) => right - left)
        expect(ReadingTable.of(columns, window).rows.map((row) => row.time.epochMillis)).toEqual(
          expected
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('each cell holds exactly its series’ entries at the row’s instant, in series order', () => {
    fc.assert(
      fc.property(columnsArb, windowArb, (columns, window) => {
        for (const row of ReadingTable.of(columns, window).rows) {
          row.cells.forEach((cell, column) => {
            const at = (time: DateTime.Utc): boolean => time.epochMillis === row.time.epochMillis
            const series = columns[column]
            const expected = Series.isSpanSeries(series)
              ? series.spans.flatMap((span) => [
                  ...(at(span.start) ? [{ kind: 'span-start', span }] : []),
                  ...(at(span.end) ? [{ kind: 'span-end', span }] : []),
                ])
              : Series.levelsOf(series)
                  .filter((level) => at(level.start))
                  .map((level) => ({ kind: 'value', level }))
            expect(cell).toEqual(expected)
          })
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a reading, a dose and a lane side by side, blank where a series has nothing', () => {
    const glucose = pointSeriesOf([
      { time: DateTime.unsafeMake(100), value: 5.4 },
      { time: DateTime.unsafeMake(300), value: 6.1 },
    ])
    const dose = levelSeriesOf([levelFrom(200, 400, 10)])
    const asleep = { id: 'asleep', label: 'Asleep', colourSlot: 0 }
    const awake = { id: 'awake', label: 'Awake', colourSlot: 1 }
    const sleep = spanSeriesOf([spanFrom(0, 300, asleep), spanFrom(300, 500, awake)])

    const table = ReadingTable.of(
      [glucose, dose, sleep],
      [DateTime.unsafeMake(50), DateTime.unsafeMake(450)]
    )

    expect(
      table.rows.map((row) => [
        row.time.epochMillis,
        ...row.cells.map((cell) =>
          cell.map((entry) =>
            entry.kind === 'value'
              ? entry.level.value
              : `${entry.span.category.id} ${entry.kind === 'span-start' ? 'starts' : 'ends'}`
          )
        ),
      ])
    ).toEqual([
      [300, [6.1], [], ['asleep ends', 'awake starts']],
      [200, [], [10], []],
      [100, [5.4], [], []],
    ])
  })
})
