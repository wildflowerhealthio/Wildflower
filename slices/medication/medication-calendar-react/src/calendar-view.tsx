import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from 'react-kitchen-sink'

import {
  deriveCalendarEvents,
  monthGrid,
  type CalendarEvent,
  type CalendarMedicationInput,
} from 'medication-calendar-core'
import { hasRefill, type MedicationView } from 'medication-sponsorship-react'

import styles from './calendar-view.module.css'

// Never-fires subscribe; the snapshot samples Date.now() on renders the caller
// already commits without also driving one per clock tick (same pattern as the
// medications view).
const noopSubscribe = (): (() => void) => (): void => {}

interface CalendarViewProps {
  readonly medications: readonly MedicationView[]
}

/** Sun-first weekday column headers. */
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const monthTitle = (year: number, month0: number): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    new Date(year, month0, 1)
  )

/** Agenda day label, e.g. `"Wed, Sep 9"` (with the year when it differs). */
const dayTitle = (date: string, todayYear: number): string => {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(year ?? todayYear, (month ?? 1) - 1, day ?? 1)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(year === todayYear ? {} : { year: 'numeric' }),
  }).format(value)
}

/** The `MedicationView` fields the calendar derives its events from. */
const toCalendarInput = (view: MedicationView): CalendarMedicationInput => ({
  id: view.medication.id,
  drugName: view.medication.displayName,
  prescriber: view.requester,
  nextFillDate: view.nextFillDate,
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
  const nowMillis = useSyncExternalStore(
    noopSubscribe,
    () => Date.now(),
    () => Date.now()
  )
  const [visible, setVisible] = useState(() => {
    const today = new Date(nowMillis)
    return { year: today.getFullYear(), month0: today.getMonth() }
  })
  const todayDate = ((): string => {
    const today = new Date(nowMillis)
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    return `${today.getFullYear()}-${month}-${day}`
  })()
  const todayYear = Number(todayDate.slice(0, 4))

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

  // Start the schedule pane with the "Now" line centred, Google Calendar
  // style; scrolling is the user's from there on.
  const paneRef = useRef<HTMLDivElement | null>(null)
  const nowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const pane = paneRef.current
    const line = nowRef.current
    if (pane === null || line === null) return
    pane.scrollTop = line.offsetTop - pane.clientHeight / 2
  }, [])

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
      <h3 className={styles.agendaDate}>{dayTitle(date, todayYear)}</h3>
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
