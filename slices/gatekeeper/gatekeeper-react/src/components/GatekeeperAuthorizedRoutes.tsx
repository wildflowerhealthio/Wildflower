import { useSyncExternalStore, type JSX } from 'react'
import { Outlet } from 'react-router'

import { readToken, subscribeToken } from '../client.ts'
import { AuthenticatedGatekeeperClientProvider } from '../gatekeeper-client-context.tsx'
import { NeedsAuthMessage } from './NeedsAuthMessage.tsx'

const noToken = (): null => null

/**
 * Route-level gate for screens that need a bearer token. Renders
 * {@link NeedsAuthMessage} when no token is present; remounts the
 * authenticated provider on token rotation.
 */
const GatekeeperAuthorizedRoutes = (): JSX.Element => {
  const token = useSyncExternalStore(subscribeToken, readToken, noToken)
  if (token === null || token === '') return <NeedsAuthMessage />
  return (
    <AuthenticatedGatekeeperClientProvider token={token}>
      <Outlet />
    </AuthenticatedGatekeeperClientProvider>
  )
}

export { GatekeeperAuthorizedRoutes }
