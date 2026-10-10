import type { CalendarEvent } from '@wildflowerhealthio/medication-calendar-core'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { JSX } from 'react'

import styles from './calendar-view.module.css'

/** One event as its day-cell line (agenda / month grid share the same styling). */
const EventLine = ({ event }: { readonly event: CalendarEvent }): JSX.Element => (
  <p className={cn(styles.event, styles[event.kind])}>{event.title}</p>
)

export { EventLine }
