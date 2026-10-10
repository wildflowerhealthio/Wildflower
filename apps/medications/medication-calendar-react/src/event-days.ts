import type { CalendarEvent } from 'medication-calendar-core'

/** Consecutive events sharing a day, in derived (sorted) order. */
interface EventDay {
  readonly date: string
  readonly events: readonly CalendarEvent[]
}

/**
 * Bucket already-sorted events into runs sharing a calendar day, preserving
 * event order within each day. The input is assumed sorted by day so a single
 * pass suffices — `deriveCalendarEvents` guarantees that.
 */
const groupByDay = (events: readonly CalendarEvent[]): readonly EventDay[] => {
  const days: { date: string; events: CalendarEvent[] }[] = []
  for (const event of events) {
    const last = days.at(-1)
    if (last !== undefined && last.date === event.date) last.events.push(event)
    else days.push({ date: event.date, events: [event] })
  }
  return days
}

export { type EventDay, groupByDay }
