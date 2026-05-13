import type { JSX } from 'react'
import { Route } from 'react-router'

import { AccountConfigScreen } from './screens/account-config.tsx'
import { AccountListScreen } from './screens/account-list.tsx'

/**
 * Authorized routes contributed by the collector slice. Mounted by the
 * app under `<Route element={<AuthorizedAppShell />}>`. The collector
 * client layer (provided once at the app's top level via
 * `<CollectorClientProvider>`) reads the live token from `BearerToken`
 * — no per-route token plumbing.
 *
 * No public collector routes today — all flows require an authed owner.
 */
const collectorAuthorizedRoutesFragment: JSX.Element = (
  <>
    <Route path="/collector" element={<AccountListScreen />} />
    <Route path="/collector/account" element={<AccountConfigScreen />} />
  </>
)

export { collectorAuthorizedRoutesFragment }
