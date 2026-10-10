import { useMemo } from 'react'

/**
 * The three `Intl.DateTimeFormat`s the calendar renders labels through, built
 * once per mount rather than per render (or per agenda day). `undefined` locale
 * = the viewer's; the zone is captured at mount, matching the session it
 * renders in. The pair of day formats handles the "different year" case in the
 * agenda without threading a comparison through every call.
 */
interface CalendarFormats {
  readonly month: Intl.DateTimeFormat
  readonly day: Intl.DateTimeFormat
  readonly dayWithYear: Intl.DateTimeFormat
}

const useCalendarFormats = (): CalendarFormats =>
  useMemo(
    () => ({
      month: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }),
      day: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      dayWithYear: new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    }),
    []
  )

export { type CalendarFormats, useCalendarFormats }
