import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

import type { EventDay } from './event-days.ts'
import { EventLine } from './event-line.tsx'
import styles from './calendar-view.module.css'

interface AgendaPaneProps {
  readonly pastDays: readonly EventDay[]
  readonly upcomingDays: readonly EventDay[]
  readonly totalEvents: number
  readonly dayTitle: (date: string) => string
}

const AgendaDay = ({
  day,
  dayTitle,
}: {
  readonly day: EventDay
  readonly dayTitle: (date: string) => string
}): JSX.Element => (
  <section className={styles.agendaDay}>
    <h3 className={styles.agendaDate}>{dayTitle(day.date)}</h3>
    {day.events.map((event) => (
      <EventLine key={event.kind} event={event} />
    ))}
  </section>
)

/**
 * The below-640px schedule: every event in one day-grouped stack, split by a
 * red "Now" line the pane starts centred on. Re-centres as streamed pages add
 * past-dated events — which grow the offset above Now — and when the pane
 * first becomes visible; user-intent events (wheel / touch / keyboard) hand
 * control over for good, so a manual scroll is not fought.
 */
const AgendaPane = ({
  pastDays,
  upcomingDays,
  totalEvents,
  dayTitle,
}: AgendaPaneProps): JSX.Element => {
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

  return (
    <div ref={paneRef} className={styles.agenda} aria-label="Schedule">
      {pastDays.map((day) => (
        <AgendaDay key={day.date} day={day} dayTitle={dayTitle} />
      ))}
      <div ref={nowRef} className={styles.nowLine} role="separator" aria-label="Now">
        <span className={styles.nowLabel}>Now</span>
      </div>
      {upcomingDays.map((day) => (
        <AgendaDay key={day.date} day={day} dayTitle={dayTitle} />
      ))}
      {totalEvents === 0 && <p className={styles.agendaEmpty}>No medication dates to show yet.</p>}
    </div>
  )
}

export { AgendaPane, type AgendaPaneProps }
