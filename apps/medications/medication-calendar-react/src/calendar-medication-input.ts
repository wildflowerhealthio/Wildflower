import type { CalendarMedicationInput as Core } from 'medication-calendar-core'
import { hasRefill, type MedicationView } from 'medication-core/fhir'

import { localCalendarDay } from './local-day.ts'

// The core input shape re-exported so this file is a complete namespace: a
// caller pulls it in as `CalendarMedicationInput` and gets both the type
// (`CalendarMedicationInput.CalendarMedicationInput`, same shape as core's)
// and the platform-side constructor (`CalendarMedicationInput.fromMedicationView`).
type CalendarMedicationInput = Core.CalendarMedicationInput

/**
 * Project a decoded `MedicationView` onto the calendar input the pure
 * layer's {@link deriveCalendarEvents} reads: the id and display name pass
 * through, and the ISO `nextFillDate` is reduced to the viewer's local
 * calendar day so the calendar's event days line up with its "today" marker.
 */
const fromMedicationView = (view: MedicationView): CalendarMedicationInput => ({
  id: view.medication.id,
  drugName: view.medication.displayName,
  prescriber: view.requester,
  nextFillDate: view.nextFillDate === null ? null : localCalendarDay(view.nextFillDate),
  hasRefill: hasRefill(view),
})

export { type CalendarMedicationInput, fromMedicationView }
