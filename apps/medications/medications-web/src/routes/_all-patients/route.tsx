import { createFileRoute } from '@tanstack/react-router'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { MedicationsPage } from '../-medications-page.tsx'

/** Every patient's medications page, its tabs at the app's top level. */
function EveryPatientsMedications(): JSX.Element {
  return (
    <MedicationsPage
      tabs={
        <RouteTabs
          tabs={[
            { to: '/medications', label: 'Medications' },
            { to: '/calendar', label: 'Calendar' },
            { to: '/interactions', label: 'Interactions' },
            { to: '/savings', label: 'Savings' },
          ]}
          aria-label="Medication views"
        />
      }
    />
  )
}

/**
 * Every patient's tabs, `/medications`, `/calendar`, `/interactions` and
 * `/savings`: a layout adding nothing to the path, which the picker's All
 * patients opens.
 */
const Route = createFileRoute('/_all-patients')({
  component: EveryPatientsMedications,
})

export { Route }
