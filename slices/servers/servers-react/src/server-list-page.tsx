import { Link } from '@tanstack/react-router'
import type { JSX } from 'react'
import { GateCard, PageHeader } from 'react-tundraish'

/**
 * The base's home, `/`: the servers on this device, with the way to the
 * base's Settings.
 *
 * @remarks
 * A placeholder for now: it lists no servers, and says so.
 */
const ServerListPage = (): JSX.Element => (
  <>
    <PageHeader
      title="Servers"
      actions={
        <Link to="/settings" className="button-3 outline">
          Settings
        </Link>
      }
    />
    <GateCard
      showSpinner={false}
      title="No servers yet"
      body="The Wildflower servers on this device will be listed here."
    />
  </>
)

export { ServerListPage }
