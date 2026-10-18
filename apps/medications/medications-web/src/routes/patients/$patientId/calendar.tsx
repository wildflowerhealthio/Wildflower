import { createFileRoute } from '@tanstack/react-router'

import { CalendarTab } from '../../-tabs/calendar/calendar-tab.tsx'

/** `/patients/$patientId/calendar`, the patient's Calendar tab. */
const Route = createFileRoute('/patients/$patientId/calendar')({
  component: CalendarTab,
})

export { Route }
