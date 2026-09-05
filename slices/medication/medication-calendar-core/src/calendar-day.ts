import { DateTime } from 'effect'

// Internal calendar-day (Y-M-D) arithmetic, shared by the month grid and event
// derivation. UTC-based (via `DateTime` on the UTC scale) so that overflow in
// year / month / day inputs normalizes without ever reading a wall clock or a
// time zone — inputs are integers or `YYYY-MM-DD` strings and outputs are
// `YYYY-MM-DD`.

/** Format a UTC year / zero-based month / day as `YYYY-MM-DD`, carrying overflow. */
const formatDay = (year: number, month0: number, day: number): string =>
  DateTime.formatIsoDate(DateTime.unsafeMake({ year, month: month0 + 1, day }))

/** Shift a `YYYY-MM-DD` day by whole calendar days (may be negative). */
const shiftDay = (day: string, deltaDays: number): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.unsafeMake(day), { days: deltaDays }))

export { formatDay, shiftDay }
