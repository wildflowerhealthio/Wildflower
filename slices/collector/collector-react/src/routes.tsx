import type { JSX } from 'react'
import { Route } from 'react-router'

import { AccountConfigScreen } from './screens/account-config.tsx'
import { AccountListScreen } from './screens/account-list.tsx'

/**
 * Owner-facing settings routes contributed by the collector slice.
 * Mounted by the app under `<Route element={<AuthorizedAppShell />}>`
 * alongside other slices' `*SettingsRoutesFragment`s. The collector
 * client layer (provided once at the app's top level via
 * `<CollectorClientProvider>`) reads the live token from `BearerToken`
 * — no per-route token plumbing.
 *
 * No public collector routes today — all flows require an authed owner.
 */
const collectorSettingsRoutesFragment: JSX.Element = (
  <>
    <Route path="/settings/collector" element={<AccountListScreen />} />
    <Route path="/settings/collector/account" element={<AccountConfigScreen />} />
  </>
)

export { collectorSettingsRoutesFragment }
