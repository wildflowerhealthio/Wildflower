import { DateTime } from 'effect'

/**
 * Format a `DateTime.Utc` for the UI. By routing every screen
 * through one helper we own the locale style in one place — change
 * here, every screen updates.
 */
const formatInstant = (dt: DateTime.Utc): string =>
  DateTime.formatLocal(dt, { dateStyle: 'medium', timeStyle: 'short' })

export { formatInstant }
