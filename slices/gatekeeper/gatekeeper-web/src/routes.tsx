import type { JSX } from 'react'
import { Route } from 'react-router'
import { GatekeeperAuthorizedRoutes } from './components/GatekeeperAuthorizedRoutes.tsx'
import { AccessIndexScreen } from './screens/access-index.tsx'
import { ApprovedAppDetailScreen } from './screens/approved-app-detail.tsx'
import { DeviceConsentScreen } from './screens/device-consent.tsx'
import { DeviceEntryScreen } from './screens/device-entry.tsx'
import { OAuthConsentScreen } from './screens/oauth-consent/index.tsx'
import { OAuthPollingScreen } from './screens/oauth-polling.tsx'
import { RequestDetailScreen } from './screens/request-detail.tsx'
import { RequestsListScreen } from './screens/requests-list.tsx'

// Exported as a JSX.Element fragment, not a component function. React Router's
// <Routes> walks its JSX children syntactically (via createRoutesFromChildren)
// and only accepts <Route> or <React.Fragment>; a custom component that
// *returns* routes is never unwrapped. Path strings hardcode the /gatekeeper
// prefix so they match the URLs the API redirects to (see
// gatekeeper-core/page-paths.ts) under both MemoryRouter (embedded bundle) and
// BrowserRouter (web bundle) without basename gymnastics. The drift test in
// tests/routes.test.tsx asserts each redirect target in `GatekeeperPaths` has
// a matching <Route path>.
const gatekeeperRoutesFragment: JSX.Element = (
  <>
    {/* Public — no bearer token required */}
    <Route path="/gatekeeper/oauth-polling/:id" element={<OAuthPollingScreen />} />
    <Route path="/gatekeeper/devices" element={<DeviceEntryScreen />} />

    {/* Owner-facing — gated by GatekeeperAuthorizedRoutes */}
    <Route element={<GatekeeperAuthorizedRoutes />}>
      <Route path="/gatekeeper" element={<AccessIndexScreen />} />
      <Route path="/gatekeeper/requests" element={<RequestsListScreen />} />
      <Route path="/gatekeeper/requests/:id" element={<RequestDetailScreen />} />
      <Route path="/gatekeeper/approved/:id" element={<ApprovedAppDetailScreen />} />
      <Route path="/gatekeeper/oauth-consent/:id" element={<OAuthConsentScreen />} />
      <Route path="/gatekeeper/devices/:userCode" element={<DeviceConsentScreen />} />
    </Route>
  </>
)

export { gatekeeperRoutesFragment }
