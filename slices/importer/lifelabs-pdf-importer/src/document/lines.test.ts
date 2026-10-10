import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { Page, Run } from 'positioned-text'
import { describe, expect, it } from 'vite-plus/test'

import { LINE_TOLERANCE, lineText, fromPage } from './table.ts'

const run = (text: string, x: number, y: number): Run.Type => ({
  text,
  x,
  y,
  width: text.length * 5,
  fontSize: 9.94,
})

const page = (runs: readonly Run.Type[]): Page.Type => ({
  pageNumber: 1,
  width: 612,
  height: 792,
  runs,
})

/** A row's worth of runs whose top edges all sit within the tolerance of `y`. */
const rowRuns = (y: number, count: number): fc.Arbitrary<Run.Type[]> =>
  fc
    .array(
      fc.record({
        text: fc.stringMatching(/^[a-z]{1,6}$/),
        x: fc.integer({ min: 0, max: 600 }),
        dy: fc.double({ min: 0, max: LINE_TOLERANCE, noNaN: true }),
      }),
      { minLength: count, maxLength: count }
    )
    .map((cells) => cells.map(({ text, x, dy }) => run(text, x, y + dy)))

describe('linesOf', () => {
  it('property: runs within the tolerance share a line, ordered by x; rows further apart split', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 100 }),
        (counts, seed) => {
          // Rows stacked 3× the tolerance apart: a row's runs spread up to one
          // tolerance below its base, so the next row's base is still more than
          // a tolerance below the highest run of this one — they can never merge.
          const rows = counts.map(
            (count, index) =>
              fc.sample(rowRuns(index * LINE_TOLERANCE * 3 + 10, count), { numRuns: 1, seed })[0] ??
              []
          )
          const shuffled = rows.flat().toReversed()

          const lines = fromPage(page(shuffled))

          expect(lines).toHaveLength(rows.length)
          lines.forEach((line, index) => {
            expect(line.cells).toHaveLength(counts[index] ?? -1)
            const xs = line.cells.map((cell) => cell.x)
            expect(xs).toEqual([...xs].toSorted((a, b) => a - b))
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('anchors on the first run of a line, so a slow drift never chains rows together', () => {
    // Four runs each 4pt lower than the last: adjacent pairs are within the
    // tolerance, but the fourth is 12pt below the first — a new line.
    const runs = [run('a', 0, 10), run('b', 10, 14), run('c', 20, 18), run('d', 30, 22)]

    const lines = fromPage(page(runs))

    expect(lines.map(lineText)).toEqual(['a b', 'c d'])
  })

  it('drops blank runs and trims the rest', () => {
    const runs = [run('  WBC ', 28, 100), run(' ', 60, 100), run('', 90, 100), run('8.0', 283, 101)]

    const lines = fromPage(page(runs))

    expect(lines).toEqual([
      {
        y: 100,
        cells: [
          { x: 28, text: 'WBC' },
          { x: 283, text: '8.0' },
        ],
      },
    ])
  })

  it('yields no lines for a page of blank runs', () => {
    expect(fromPage(page([run(' ', 0, 0), run('', 5, 5)]))).toEqual([])
  })
})
