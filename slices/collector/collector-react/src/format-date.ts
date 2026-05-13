import { DateTime } from 'effect'

/** Format a `DateTime.Utc` for the UI. Single source of truth for locale style. */
const formatInstant = (dt: DateTime.Utc): string =>
  DateTime.formatLocal(dt, { dateStyle: 'medium', timeStyle: 'short' })

export { formatInstant }
