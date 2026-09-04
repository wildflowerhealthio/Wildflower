import { formatDay } from './calendar-day.ts'

/** One day cell of a month grid: its `YYYY-MM-DD` date and whether it belongs to the grid's month. */
interface CalendarCell {
  readonly date: string
  readonly inMonth: boolean
}

/**
 * The 42-cell (6 weeks × 7 days), Sunday-start day grid for the given month.
 * Leading cells back-fill from the previous month to the prior Sunday; trailing
 * cells fill from the next month to reach 42. Pure date math — `year`/`month0`
 * are integers (`month0` is zero-based), so no wall clock or time zone is read.
 */
const monthGrid = (year: number, month0: number): readonly CalendarCell[] => {
  const lead = new Date(Date.UTC(year, month0, 1)).getUTCDay()
  const cells: CalendarCell[] = []
  for (let index = 0; index < 42; index += 1) {
    const cellDate = new Date(Date.UTC(year, month0, 1 - lead + index))
    cells.push({
      date: formatDay(year, month0, 1 - lead + index),
      inMonth: cellDate.getUTCMonth() === month0,
    })
  }
  return cells
}

export { type CalendarCell, monthGrid }
