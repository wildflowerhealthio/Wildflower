// Internal calendar-day (Y-M-D) arithmetic, shared by the month grid and event
// derivation. UTC-based so that `Date`'s overflow normalization does the
// day/month/year carrying without ever reading a wall clock or a time zone —
// inputs are integers or `YYYY-MM-DD` strings and outputs are `YYYY-MM-DD`.

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Format a UTC year / zero-based month / day as `YYYY-MM-DD`, carrying overflow. */
const formatDay = (year: number, month0: number, day: number): string => {
  const date = new Date(Date.UTC(year, month0, day))
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** Shift a `YYYY-MM-DD` day by whole calendar days (may be negative). */
const shiftDay = (day: string, deltaDays: number): string => {
  const [year, month, date] = day.split('-').map(Number)
  return formatDay(year, month - 1, date + deltaDays)
}

export { formatDay, shiftDay }
