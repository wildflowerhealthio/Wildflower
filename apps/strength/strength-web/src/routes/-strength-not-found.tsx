import { useLocation, useNavigate } from '@tanstack/react-router'
import { GateCard } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/**
 * The tab panel for a path no tab names (a stale bookmark, `/index.html`),
 * under the tab strip with no tab current, offering the app root, which opens
 * the patient's first tab: Today for a lifter, History for All patients. The
 * patient stays as the address bar names it.
 */
function StrengthNotFound(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  return (
    <GateCard
      title={`Strength has no page at ${pathname}.`}
      showSpinner={false}
      action={{
        label: 'Open Strength',
        onClick: () => {
          void navigate({ to: '/' })
        },
      }}
    />
  )
}

export { StrengthNotFound }
