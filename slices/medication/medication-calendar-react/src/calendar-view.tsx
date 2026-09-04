import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn, useNowDay } from 'react-kitchen-sink'

import {
  deriveCalendarEvents,
  monthGrid,
  type CalendarEvent,
  type CalendarMedicationInput,
} from 'medication-calendar-core'
import { hasRefill, type MedicationView } from 'medication-sponsorship-react'

import styles from './calendar-view.module.css'

interface CalendarViewProps {
  readonly medications: readonly MedicationView[]
}

/** Sun-first weekday column headers. */
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const pad2 = (n: number): string => String(n).padStart(2, '0')

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

/** The `MedicationView` fields the calendar derives its events from. */
const toCalendarInput = (view: MedicationView): CalendarMedicationInput => ({
  id: view.medication.id,
  drugName: view.medication.displayName,
  prescriber: view.requester,
  nextFillDate: view.nextFillDate === null ? null : localCalendarDay(view.nextFillDate),
  hasRefill: hasRefill(view),
})

const eventLine = (event: CalendarEvent): JSX.Element => (
  <p key={event.kind} className={cn(styles.event, styles[event.kind])}>
    {event.title}
  </p>
)

/** Consecutive events sharing a day, in derived (sorted) order. */
const groupByDay = (
  events: readonly CalendarEvent[]
): readonly { readonly date: string; readonly events: readonly CalendarEvent[] }[] => {
  const days: { date: string; events: CalendarEvent[] }[] = []
  for (const event of events) {
    const last = days.at(-1)
    if (last !== undefined && last.date === event.date) last.events.push(event)
    else days.push({ date: event.date, events: [event] })
  }
  return days
}

/**
 * A month-grid **calendar of prescription dates**: a pickup item on each
 * next-fill date, a renewal-appointment reminder a week before a supply runs
 * out for good, and a marker on the exhaustion day itself — same-day items of
 * one kind merged into a single fluent entry. Sunday-start, with
 * previous/next month navigation from the current month; events come from
 * whatever prescriptions the caller passes (the pages loaded so far).
 *
 * On screens narrower than 640px the grid gives way to a schedule: every
 * event in one day-grouped stack, scrollable both ways from a red "Now" line
 * that the pane starts centred on.
 */
export const CalendarView = ({ medications }: CalendarViewProps): JSX.Element => {
  // Today's local day, sampled through a quantized store so the render stays
  // pure and the snapshot is cached (no per-millisecond re-render); everything
  // downstream needs only day granularity.
  const todayDate = useNowDay()
  const todayYear = Number(todayDate.slice(0, 4))
  const [visible, setVisible] = useState(() => {
    const [year, month] = todayDate.split('-').map(Number)
    return { year: year ?? todayYear, month0: (month ?? 1) - 1 }
  })

  // Intl formatters are expensive to build; construct each once per mount rather
  // than on every render (and every agenda day). `undefined` locale = the
  // viewer's; the zone is captured at mount, matching the session it renders in.
  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }),
    []
  )
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    []
  )
  const dayWithYearFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    []
  )
  const monthTitle = (year: number, month0: number): string =>
    monthFormat.format(new Date(year, month0, 1))
  // Agenda day label, e.g. `"Wed, Sep 9"` (with the year when it differs).
  const dayTitle = (date: string): string => {
    const [year, month, day] = date.split('-').map(Number)
    const value = new Date(year ?? todayYear, (month ?? 1) - 1, day ?? 1)
    return (year === todayYear ? dayFormat : dayWithYearFormat).format(value)
  }

  const events = useMemo(
    () => deriveCalendarEvents(medications.map(toCalendarInput)),
    [medications]
  )
  const eventsByDate = useMemo(() => {
    const byDate = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const existing = byDate.get(event.date)
      if (existing === undefined) byDate.set(event.date, [event])
      else existing.push(event)
    }
    return byDate
  }, [events])
  // The schedule splits at "now": past days scroll up, the rest scroll down.
  const pastDays = useMemo(
    () => groupByDay(events.filter((event) => event.date < todayDate)),
    [events, todayDate]
  )
  const upcomingDays = useMemo(
    () => groupByDay(events.filter((event) => event.date >= todayDate)),
    [events, todayDate]
  )

  // Keep the schedule pane's "Now" line centred (Google Calendar style) until
  // the user scrolls it themselves. Re-centre as streamed pages add past-dated
  // events — which grow the offset above Now — and when the pane first becomes
  // visible: the agenda is `display: none` at ≥640px, so at mount its height is
  // 0 and the initial assignment would be a no-op; a resize below the breakpoint
  // swaps it in without a remount.
  const paneRef = useRef<HTMLDivElement | null>(null)
  const nowRef = useRef<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)
  useEffect(() => {
    const pane = paneRef.current
    const line = nowRef.current
    if (pane === null || line === null) return undefined

    const centre = (): void => {
      // Skip once the user has taken over, and while the pane is hidden
      // (`clientHeight` 0 at ≥640px, where the grid shows instead).
      if (userScrolledRef.current || pane.clientHeight === 0) return
      pane.scrollTop = line.offsetTop - pane.clientHeight / 2
    }
    centre()

    // User-intent events hand control over for good. A plain `scroll` listener
    // can't be used — the programmatic `scrollTop` above would re-arm it.
    const markScrolled = (): void => {
      userScrolledRef.current = true
    }
    pane.addEventListener('wheel', markScrolled, { passive: true })
    pane.addEventListener('touchmove', markScrolled, { passive: true })
    pane.addEventListener('keydown', markScrolled)

    // Re-centre when the pane resizes into view (the CSS breakpoint swap).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(centre)
    observer?.observe(pane)

    return () => {
      pane.removeEventListener('wheel', markScrolled)
      pane.removeEventListener('touchmove', markScrolled)
      pane.removeEventListener('keydown', markScrolled)
      observer?.disconnect()
    }
    // `pastDays` isn't read in the body, but a new page of past events grows the
    // Now line's DOM offset — depend on it so the pane re-centres on the change.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [pastDays])

  const cells = monthGrid(visible.year, visible.month0)

  const step = (offset: number): void => {
    setVisible(({ year, month0 }) => {
      const shifted = new Date(year, month0 + offset, 1)
      return { year: shifted.getFullYear(), month0: shifted.getMonth() }
    })
  }

  const agendaDay = ({
    date,
    events: dayEvents,
  }: {
    readonly date: string
    readonly events: readonly CalendarEvent[]
  }): JSX.Element => (
    <section key={date} className={styles.agendaDay}>
      <h3 className={styles.agendaDate}>{dayTitle(date)}</h3>
      {dayEvents.map(eventLine)}
    </section>
  )

  return (
    <div className={styles.calendar}>
      <div className={styles.monthBar}>
        <button
          type="button"
          className={styles.monthStep}
          aria-label="Previous month"
          onClick={() => {
            step(-1)
          }}
        >
          ‹
        </button>
        <h2 className={cn(styles.monthTitle, 'text-heading-2')}>
          {monthTitle(visible.year, visible.month0)}
        </h2>
        <button
          type="button"
          className={styles.monthStep}
          aria-label="Next month"
          onClick={() => {
            step(1)
          }}
        >
          ›
        </button>
      </div>
      <table className={styles.grid}>
        <thead>
          <tr>
            {weekdays.map((weekday) => (
              <th key={weekday} scope="col" className={styles.weekday}>
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: cells.length / 7 }, (_, week) => (
            <tr key={week}>
              {cells.slice(week * 7, week * 7 + 7).map((cell) => (
                <td
                  key={cell.date}
                  className={cn(styles.day, !cell.inMonth && styles.outside)}
                  aria-current={cell.date === todayDate ? 'date' : undefined}
                >
                  <span className={styles.dayNumber}>{Number(cell.date.slice(8, 10))}</span>
                  {(eventsByDate.get(cell.date) ?? []).map(eventLine)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div ref={paneRef} className={styles.agenda} aria-label="Schedule">
        {pastDays.map(agendaDay)}
        <div ref={nowRef} className={styles.nowLine} role="separator" aria-label="Now">
          <span className={styles.nowLabel}>Now</span>
        </div>
        {upcomingDays.map(agendaDay)}
        {events.length === 0 && (
          <p className={styles.agendaEmpty}>No medication dates to show yet.</p>
        )}
      </div>
    </div>
  )
}

export type { CalendarViewProps }
