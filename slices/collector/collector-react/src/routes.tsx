import type { JSX } from 'react'
import { Route } from 'react-router'

import { AccountConfigScreen } from './screens/account-config.tsx'
import { AccountListScreen } from './screens/account-list.tsx'

/**
 * Owner-facing collector routes contributed by the collector slice.
 * Mounted by the app under `<Route element={<AuthorizedAppShell />}>`
 * alongside other slices' authenticated-route fragments. The collector
 * client layer (provided once at the app's top level via
 * `<CollectorClientProvider>`) reads the live token from `BearerToken`
 * — no per-route token plumbing.
 *
 * Collector is top-level functionality (not a settings concern), so its
 * routes live at `/collector/*` rather than under `/settings/`.
 */
const collectorAuthenticatedRoutesFragment: JSX.Element = (
  <>
    <Route path="/collector" element={<AccountListScreen />} />
    <Route path="/collector/account/new" element={<AccountConfigScreen />} />
    <Route path="/collector/account/:id" element={<AccountConfigScreen />} />
  </>
)

export { collectorAuthenticatedRoutesFragment }
