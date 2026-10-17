import { CalendarView } from '@wildflowerhealthio/medication-calendar-react'
import type { JSX } from 'react'

import { useMedicationRead } from '../../-medication-read.ts'
import { PartialListBanner } from '../../-partial-list-banner.tsx'

/**
 * The Calendar tab: the prescription calendar over the medications landed
 * so far, under the partial-list banner while the list is incomplete.
 */
function CalendarTab(): JSX.Element {
  const { views } = useMedicationRead()
  return (
    <>
      <PartialListBanner />
      <CalendarView medications={views} />
    </>
  )
}

export { CalendarTab }
