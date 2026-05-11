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

// Exported as a JSX.Element (not a component): <Routes> walks children syntactically.
// Paths hardcode the /gatekeeper prefix so they match `gatekeeper-core/page-paths`
// under both MemoryRouter and BrowserRouter without basename gymnastics; the
// drift test in tests/routes.test.tsx asserts each redirect target has a matching <Route>.
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
