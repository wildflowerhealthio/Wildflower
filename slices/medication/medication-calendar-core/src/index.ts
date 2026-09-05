/**
 * The pure calendar layer for a patient's medication list: project the
 * next-fill / exhaustion instant off an authored date given a supply duration
 * ({@link nextFillDate}, which reads a `SupplyDuration` from `fhir-utility`),
 * derive the dated pickup / appointment / exhausted events
 * ({@link deriveCalendarEvents}), and lay out a month's day grid
 * ({@link monthGrid}). No DOM, no FHIR wire schemas, no platform imports —
 * the FHIR-shaped supply-duration parser lives in `fhir-utility`.
 *
 * `CalendarMedicationInput` — the input shape `deriveCalendarEvents` reads —
 * is exposed Effect-style as a namespace: `CalendarMedicationInput.CalendarMedicationInput`
 * is the type, and platform adapters can layer constructors (e.g.
 * `medication-calendar-react`'s `fromMedicationView`) onto their own
 * namespace of the same name.
 *
 * @packageDocumentation
 */
export { nextFillDate } from './supply.ts'

export { type CalendarEvent, type CalendarEventKind, deriveCalendarEvents } from './calendar.ts'

export { type CalendarCell, monthGrid } from './month-grid.ts'

export * as CalendarMedicationInput from './calendar-medication-input.ts'
