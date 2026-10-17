import { createFileRoute } from '@tanstack/react-router'

import { CalendarTab } from '../-tabs/calendar/calendar-tab.tsx'

/** `/calendar`, every patient's Calendar tab. */
const Route = createFileRoute('/_all-patients/calendar')({
  component: CalendarTab,
})

export { Route }
