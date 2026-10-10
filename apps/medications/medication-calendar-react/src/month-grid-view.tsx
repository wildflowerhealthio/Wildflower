import { monthGrid } from 'medication-calendar-core'
import type { CalendarEvent } from 'medication-calendar-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { EventLine } from './event-line.tsx'
import styles from './calendar-view.module.css'

/** Sun-first weekday column headers. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** The current month position the header steps through. */
interface VisibleMonth {
  readonly year: number
  readonly month0: number
}

interface MonthGridViewProps {
  readonly visible: VisibleMonth
  readonly todayDate: string
  readonly eventsByDate: ReadonlyMap<string, readonly CalendarEvent[]>
  readonly monthTitle: string
  readonly onStep: (offset: number) => void
}

/**
 * The month header (title + prev/next buttons) and the Sunday-start table
 * of day cells, with derived events rendered under each cell's day number.
 * Rendered at ≥640px; below the breakpoint the CSS swaps in the agenda.
 */
const MonthGridView = ({
  visible,
  todayDate,
  eventsByDate,
  monthTitle,
  onStep,
}: MonthGridViewProps): JSX.Element => {
  const cells = monthGrid(visible.year, visible.month0)
  return (
    <>
      <div className={styles.monthBar}>
        <button
          type="button"
          className={styles.monthStep}
          aria-label="Previous month"
          onClick={() => {
            onStep(-1)
          }}
        >
          ‹
        </button>
        <h2 className={cn(styles.monthTitle, 'text-heading-2')}>{monthTitle}</h2>
        <button
          type="button"
          className={styles.monthStep}
          aria-label="Next month"
          onClick={() => {
            onStep(1)
          }}
        >
          ›
        </button>
      </div>
      <table className={styles.grid}>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
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
                  {(eventsByDate.get(cell.date) ?? []).map((event) => (
                    <EventLine key={event.kind} event={event} />
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export { MonthGridView, type MonthGridViewProps, type VisibleMonth }
