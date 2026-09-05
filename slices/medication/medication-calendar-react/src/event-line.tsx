import type { CalendarEvent } from 'medication-calendar-core'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './calendar-view.module.css'

/** One event as its day-cell line (agenda / month grid share the same styling). */
const EventLine = ({ event }: { readonly event: CalendarEvent }): JSX.Element => (
  <p className={cn(styles.event, styles[event.kind])}>{event.title}</p>
)

export { EventLine }
