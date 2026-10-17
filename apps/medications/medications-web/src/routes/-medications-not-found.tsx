import { useLocation, useNavigate } from '@tanstack/react-router'
import { GateCard } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/**
 * The tab panel for a path no tab names (a stale bookmark, `/index.html`),
 * under the tab strip with no tab current, offering the Medications tab. The
 * patient stays as the address bar names it.
 */
function MedicationsNotFound(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  return (
    <GateCard
      title={`The Medication Viewer has no page at ${pathname}.`}
      showSpinner={false}
      action={{
        label: 'Open the medications list',
        onClick: () => {
          void navigate({ to: '/medications' })
        },
      }}
    />
  )
}

export { MedicationsNotFound }
