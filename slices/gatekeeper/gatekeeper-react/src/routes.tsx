import type { JSX } from 'react'
import { Route } from 'react-router'
import { AccessIndexScreen } from './screens/access-index.tsx'
import { ApprovedAppDetailScreen } from './screens/approved-app-detail.tsx'
import { DeviceConsentScreen } from './screens/device-consent.tsx'
import { DeviceEntryScreen } from './screens/device-entry.tsx'
import { OAuthConsentScreen } from './screens/oauth-consent/index.tsx'
import { OAuthPollingScreen } from './screens/oauth-polling.tsx'
import { RequestDetailScreen } from './screens/request-detail.tsx'
import { RequestsListScreen } from './screens/requests-list.tsx'

// Exported as JSX.Elements (not components): React Router's <Routes>
// walks children syntactically and rejects custom components with
// "[X] is not a <Route>". Paths hardcode the /gatekeeper or
// /settings/gatekeeper prefix so they match without basename gymnastics
// under both MemoryRouter and BrowserRouter; the drift test in
// tests/routes.test.tsx asserts each redirect target has a matching
// <Route>.
//
// Three fragments, three intents:
//   - Open routes: no bearer required (OAuth device-polling + the
//     unauthed device-entry form). Paths are externally published via
//     `GatekeeperPaths` and so MUST stay at `/gatekeeper/*`.
//   - Authenticated routes: require a bearer and are deep-linked from
//     the OAuth / RFC 8628 device flow (`oauth-consent/:id`,
//     `devices/:userCode`). Their paths are also externally published
//     and MUST stay at `/gatekeeper/*`.
//   - Settings routes: owner-facing landings for managing access
//     (index, request list/detail, approved-app detail). These live
//     under `/settings/gatekeeper/*` alongside the other slices'
//     `*SettingsRoutesFragment`s.

/** Open routes — no bearer token required. */
const gatekeeperOpenRoutesFragment: JSX.Element = (
  <>
    <Route path="/gatekeeper/oauth-polling/:id" element={<OAuthPollingScreen />} />
    <Route path="/gatekeeper/devices" element={<DeviceEntryScreen />} />
  </>
)

/**
 * Authenticated routes — require a bearer token. Deep-linked from the
 * OAuth + RFC 8628 device flows; the paths are published via
 * `GatekeeperPaths` so external clients can target them and must not
 * move.
 */
const gatekeeperAuthenticatedRoutesFragment: JSX.Element = (
  <>
    <Route path="/gatekeeper/oauth-consent/:id" element={<OAuthConsentScreen />} />
    <Route path="/gatekeeper/devices/:userCode" element={<DeviceConsentScreen />} />
  </>
)

/**
 * Owner-facing settings routes — require a bearer token. Mounted by
 * the app under `<Route element={<AuthorizedAppShell />}>` alongside
 * the other slices' `*SettingsRoutesFragment`s. The unified
 * `/settings` screen links to `/settings/gatekeeper` via
 * `gatekeeperSettingsItemsFragment`.
 */
const gatekeeperSettingsRoutesFragment: JSX.Element = (
  <>
    <Route path="/settings/gatekeeper" element={<AccessIndexScreen />} />
    <Route path="/settings/gatekeeper/requests" element={<RequestsListScreen />} />
    <Route path="/settings/gatekeeper/requests/:id" element={<RequestDetailScreen />} />
    <Route path="/settings/gatekeeper/approved/:id" element={<ApprovedAppDetailScreen />} />
  </>
)

export {
  gatekeeperOpenRoutesFragment,
  gatekeeperAuthenticatedRoutesFragment,
  gatekeeperSettingsRoutesFragment,
}
