import { DateTime } from 'effect'

import { formatDay } from './calendar-day.ts'

/** One day cell of a month grid: its `YYYY-MM-DD` date and whether it belongs to the grid's month. */
interface CalendarCell {
  readonly date: string
  readonly inMonth: boolean
}

/**
 * The 42-cell (6 weeks × 7 days), Sunday-start day grid for the given month.
 * Leading cells back-fill from the previous month to the prior Sunday; trailing
 * cells fill from the next month to reach 42. Pure date math on the UTC scale
 * (via {@link DateTime}) — `year`/`month0` are integers (`month0` is
 * zero-based), so no wall clock or time zone is read.
 */
const monthGrid = (year: number, month0: number): readonly CalendarCell[] => {
  const firstOfMonth = DateTime.unsafeMake({ year, month: month0 + 1, day: 1 })
  const lead = DateTime.toPartsUtc(firstOfMonth).weekDay
  return Array.from({ length: 42 }, (_, index): CalendarCell => {
    const day = 1 - lead + index
    const cell = DateTime.unsafeMake({ year, month: month0 + 1, day })
    return {
      date: formatDay(year, month0, day),
      inMonth: DateTime.toPartsUtc(cell).month === month0 + 1,
    }
  })
}

export { type CalendarCell, monthGrid }
