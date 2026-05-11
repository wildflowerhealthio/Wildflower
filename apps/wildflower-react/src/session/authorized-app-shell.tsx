import { GatekeeperClientProvider, NeedsAuthMessage } from 'gatekeeper-react'
import type { JSX } from 'react'
import { Outlet } from 'react-router'
import { useToken } from './use-token.ts'

/**
 * Outlet wrapper that gates owner-facing routes on a live bearer token.
 *
 * - No token: renders `<NeedsAuthMessage>` in-place (which kicks off the
 *   RFC 8628 device flow against the unauthenticated client provided
 *   higher up in the tree). On approval, the device-flow handler writes
 *   the token to storage; this component re-renders and flips into the
 *   authenticated branch with the new token attached.
 * - Token present: re-provides `<GatekeeperClientProvider token={…}>`
 *   so descendants' `useGatekeeperClient()` returns a bearer-attached
 *   client, then renders the matched child `<Route>` via `<Outlet>`.
 *
 * Per-slice client providers (e.g. `<CollectorClientProvider token>`)
 * compose underneath this same `if (token)` branch as additional slices
 * land.
 */
const AuthorizedAppShell = (): JSX.Element => {
  const token = useToken()
  if (token === null || token === '') return <NeedsAuthMessage />
  return (
    <GatekeeperClientProvider token={token}>
      <Outlet />
    </GatekeeperClientProvider>
  )
}

export { AuthorizedAppShell }
