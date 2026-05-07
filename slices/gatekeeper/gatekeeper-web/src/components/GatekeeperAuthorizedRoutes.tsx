import { useSyncExternalStore, type JSX } from 'react'
import { Outlet } from 'react-router'

import { readToken, subscribeToken } from '../client.ts'
import { AuthenticatedGatekeeperClientProvider } from '../gatekeeper-client-context.tsx'
import { NeedsAuthMessage } from './NeedsAuthMessage.tsx'

const noToken = (): null => null

/**
 * Route-level gate for screens that need a bearer token. Subscribes
 * to token changes (same-window via `writeToken`'s dispatched event,
 * cross-tab via the native `storage` event); when the token rotates,
 * `useSyncExternalStore` triggers a re-render so the provider remounts
 * with the new session and downstream screens swap in transparently.
 *
 * @remarks
 * Designed for `<Route element={<GatekeeperAuthorizedRoutes />}>` nesting
 * in react-router. Uses `<Outlet />` so the wrapper composes with
 * any number of child routes.
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
