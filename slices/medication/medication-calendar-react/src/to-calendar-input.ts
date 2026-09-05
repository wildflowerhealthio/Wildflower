import type { CalendarMedicationInput } from 'medication-calendar-core'
import { hasRefill, type MedicationView } from 'medication-sponsorship-react'

import { localCalendarDay } from './local-day.ts'

/** The `MedicationView` fields the calendar derives its events from. */
const toCalendarInput = (view: MedicationView): CalendarMedicationInput => ({
  id: view.medication.id,
  drugName: view.medication.displayName,
  prescriber: view.requester,
  nextFillDate: view.nextFillDate === null ? null : localCalendarDay(view.nextFillDate),
  hasRefill: hasRefill(view),
})

export { toCalendarInput }
