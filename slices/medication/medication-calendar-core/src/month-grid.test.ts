import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { monthGrid } from './month-grid.ts'

const yearMonth = fc.record({
  year: fc.integer({ min: 1970, max: 2100 }),
  month0: fc.integer({ min: 0, max: 11 }),
})

const dayMillis = 86_400_000
const parseDay = (day: string): number => Date.parse(`${day}T00:00:00Z`)

describe('monthGrid', () => {
  test('always yields exactly 42 cells', () => {
    fc.assert(
      fc.property(yearMonth, ({ year, month0 }) => {
        expect(monthGrid(year, month0)).toHaveLength(42)
      })
    )
  })

  test('starts on a Sunday', () => {
    fc.assert(
      fc.property(yearMonth, ({ year, month0 }) => {
        const first = monthGrid(year, month0)[0]
        expect(new Date(parseDay(first.date)).getUTCDay()).toBe(0)
      })
    )
  })

  test('consecutive cells differ by exactly one calendar day', () => {
    fc.assert(
      fc.property(yearMonth, ({ year, month0 }) => {
        const grid = monthGrid(year, month0)
        for (let index = 1; index < grid.length; index += 1) {
          expect(parseDay(grid[index].date) - parseDay(grid[index - 1].date)).toBe(dayMillis)
        }
      })
    )
  })

  test('the inMonth cells are exactly days 1..daysInMonth of the given month', () => {
    fc.assert(
      fc.property(yearMonth, ({ year, month0 }) => {
        const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
        const inMonth = monthGrid(year, month0).filter((cell) => cell.inMonth)
        expect(inMonth.map((cell) => cell.date)).toEqual(
          Array.from({ length: daysInMonth }, (_, day) => {
            const date = new Date(Date.UTC(year, month0, day + 1))
            return date.toISOString().slice(0, 10)
          })
        )
      })
    )
  })

  test('cells outside the month are flagged inMonth:false', () => {
    fc.assert(
      fc.property(yearMonth, ({ year, month0 }) => {
        for (const cell of monthGrid(year, month0)) {
          const cellMonth = new Date(parseDay(cell.date)).getUTCMonth()
          expect(cell.inMonth).toBe(cellMonth === month0)
        }
      })
    )
  })
})
