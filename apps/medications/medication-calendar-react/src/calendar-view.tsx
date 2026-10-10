import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { useNowDay } from 'react-kitchen-sink'

import { deriveCalendarEvents, type CalendarEvent } from 'medication-calendar-core'
import type { MedicationView } from 'medication-core/fhir'

import { AgendaPane } from './agenda-pane.tsx'
import * as CalendarMedicationInput from './calendar-medication-input.ts'
import { useCalendarFormats } from './date-formats.ts'
import { groupByDay } from './event-days.ts'
import { MonthGridView, type VisibleMonth } from './month-grid-view.tsx'
import styles from './calendar-view.module.css'

interface CalendarViewProps {
  readonly medications: readonly MedicationView[]
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
  const [visible, setVisible] = useState<VisibleMonth>(() => {
    const [year, month] = todayDate.split('-').map(Number)
    return { year: year ?? todayYear, month0: (month ?? 1) - 1 }
  })

  const formats = useCalendarFormats()
  const monthTitle = formats.month.format(new Date(visible.year, visible.month0, 1))
  // Agenda day label, e.g. `"Wed, Sep 9"` (with the year when it differs).
  const dayTitle = (date: string): string => {
    const [year, month, day] = date.split('-').map(Number)
    const value = new Date(year ?? todayYear, (month ?? 1) - 1, day ?? 1)
    return (year === todayYear ? formats.day : formats.dayWithYear).format(value)
  }

  const events = useMemo(
    () => deriveCalendarEvents(medications.map(CalendarMedicationInput.fromMedicationView)),
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

  const step = (offset: number): void => {
    setVisible(({ year, month0 }) => {
      const shifted = new Date(year, month0 + offset, 1)
      return { year: shifted.getFullYear(), month0: shifted.getMonth() }
    })
  }

  return (
    <div className={styles.calendar}>
      <MonthGridView
        visible={visible}
        todayDate={todayDate}
        eventsByDate={eventsByDate}
        monthTitle={monthTitle}
        onStep={step}
      />
      <AgendaPane
        pastDays={pastDays}
        upcomingDays={upcomingDays}
        totalEvents={events.length}
        dayTitle={dayTitle}
      />
    </div>
  )
}

export type { CalendarViewProps }
