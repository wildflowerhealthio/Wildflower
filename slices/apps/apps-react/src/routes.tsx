import type { JSX } from 'react'
import { Route } from 'react-router'

import { AppsHomeScreen } from './screens/apps-home-screen.tsx'

/**
 * Authorized routes contributed by the apps slice. Mounted by the app
 * under `<Route element={<AuthorizedAppShell />}>`. The apps client
 * layer (provided once at the app's top level via
 * `<AppsClientProvider>`) reads the live token from `BearerToken` —
 * no per-route token plumbing.
 */
const appsAuthorizedRoutesFragment: JSX.Element = (
  <Route path="/apps" element={<AppsHomeScreen />} />
)

export { appsAuthorizedRoutesFragment }
