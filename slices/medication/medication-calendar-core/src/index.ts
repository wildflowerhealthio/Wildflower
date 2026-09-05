/**
 * The pure calendar layer for a patient's medication list: project the
 * next-fill / exhaustion instant off an authored date given a supply duration
 * ({@link nextFillDate}, which reads a `SupplyDuration` from `fhir-utility`),
 * derive the dated pickup / appointment / exhausted events
 * ({@link deriveCalendarEvents}), and lay out a month's day grid
 * ({@link monthGrid}). No DOM, no FHIR wire schemas, no platform imports —
 * the FHIR-shaped supply-duration parser lives in `fhir-utility`.
 *
 * @packageDocumentation
 */
export { nextFillDate } from './supply.ts'

export {
  type CalendarEvent,
  type CalendarEventKind,
  type CalendarMedicationInput,
  deriveCalendarEvents,
} from './calendar.ts'

export { type CalendarCell, monthGrid } from './month-grid.ts'
