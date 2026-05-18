import type { JSX } from 'react'
import { Route } from 'react-router'

import { TunnelScreen } from './screens/tunnel-screen.tsx'

/**
 * Authorized routes contributed by the tunnel slice. Mounted by the
 * app under `<Route element={<AuthorizedAppShell />}>`. The tunnel
 * client layer (provided once at the app's top level via
 * `<TunnelClientProvider>`) reads the live token from `BearerToken` —
 * no per-route token plumbing.
 */
const tunnelAuthorizedRoutesFragment: JSX.Element = (
  <Route path="/tunnel" element={<TunnelScreen />} />
)

export { tunnelAuthorizedRoutesFragment }
