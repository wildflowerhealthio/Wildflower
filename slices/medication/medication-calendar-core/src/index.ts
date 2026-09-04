/**
 * The pure calendar layer for a patient's medication list: parse a supply
 * duration and project the next-fill / exhaustion instant off an authored date
 * ({@link supplyDurationToParts}, {@link nextFillDate}), derive the dated
 * pickup / appointment / exhausted events ({@link deriveCalendarEvents}), and
 * lay out a month's day grid ({@link monthGrid}). No DOM, no FHIR, no platform
 * imports.
 *
 * @packageDocumentation
 */
export { nextFillDate, type SupplyDuration, supplyDurationToParts } from './supply.ts'

export {
  type CalendarEvent,
  type CalendarEventKind,
  type CalendarMedicationInput,
  deriveCalendarEvents,
} from './calendar.ts'

export { type CalendarCell, monthGrid } from './month-grid.ts'
