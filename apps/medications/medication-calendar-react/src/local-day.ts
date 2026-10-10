import { pad2 } from 'kitchen-sink'

/**
 * Reduce an ISO instant to the viewer's **local** calendar day (`YYYY-MM-DD`).
 * `nextFillDate` is a UTC (`Z`-suffixed) instant, so its date part is the *UTC*
 * day; an evening fill in a UTC-negative zone belongs on the previous local day.
 * Reading local time here (not in the pure `-core` layer) keeps the calendar's
 * event days on the same footing as its "today" marker, which is also local.
 */
const localCalendarDay = (iso: string): string => {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export { localCalendarDay }
