import { createFileRoute } from '@tanstack/react-router'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import { walkthroughAnchor } from '@wildflowerhealthio/walkthrough-core'
import { Schema } from 'effect'
import type { JSX } from 'react'

import { MedicationsPage } from '../-medications-page.tsx'
import { MedicationsPageSearch, MedicationsWalkthroughAnchor } from '../-medications-walkthrough.ts'

/** Every patient's medications page, its tabs at the app's top level. */
function EveryPatientsMedications(): JSX.Element {
  return (
    <MedicationsPage
      tabs={
        <RouteTabs
          tabs={[
            {
              to: '/medications',
              label: 'Medications',
              ...walkthroughAnchor(MedicationsWalkthroughAnchor.medicationsTab),
            },
            {
              to: '/calendar',
              label: 'Calendar',
              ...walkthroughAnchor(MedicationsWalkthroughAnchor.calendarTab),
            },
            {
              to: '/savings',
              label: 'Savings',
              ...walkthroughAnchor(MedicationsWalkthroughAnchor.savingsTab),
            },
          ]}
          aria-label="Medication views"
        />
      }
    />
  )
}

/**
 * Every patient's tabs, `/medications`, `/calendar` and `/savings`: a layout
 * adding nothing to the path, which the picker's All patients opens. There
 * is no every-patient Interactions tab: interactions are between one
 * person's medications. `?walkthrough=show` shows the Medications
 * walkthrough again.
 */
const Route = createFileRoute('/_all-patients')({
  validateSearch: Schema.standardSchemaV1(MedicationsPageSearch),
  component: EveryPatientsMedications,
})

export { Route }
