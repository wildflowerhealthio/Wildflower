import { DateTime } from 'effect'

// Internal calendar-day (`YYYY-MM-DD`) arithmetic for event derivation.
// UTC-based (via `DateTime` on the UTC scale) so it never reads a wall clock or
// a time zone.

/** Shift a `YYYY-MM-DD` day by whole calendar days (may be negative). */
const shiftDay = (day: string, deltaDays: number): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.unsafeMake(day), { days: deltaDays }))

export { shiftDay }
