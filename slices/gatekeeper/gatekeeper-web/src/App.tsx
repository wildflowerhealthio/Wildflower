import type { JSX } from 'react'
import { Route, Routes } from 'react-router'
import { GatekeeperAuthorizedRoutes } from './components/GatekeeperAuthorizedRoutes.tsx'
import { HostBridge } from './host-bridge.tsx'
import { AccessIndexScreen } from './screens/access-index.tsx'
import { ApprovedAppDetailScreen } from './screens/approved-app-detail.tsx'
import { DeviceConsentScreen } from './screens/device-consent.tsx'
import { DeviceEntryScreen } from './screens/device-entry.tsx'
import { OAuthConsentScreen } from './screens/oauth-consent/index.tsx'
import { OAuthPollingScreen } from './screens/oauth-polling.tsx'
import { RequestDetailScreen } from './screens/request-detail.tsx'
import { RequestsListScreen } from './screens/requests-list.tsx'

const App = (): JSX.Element => (
  <>
    <HostBridge />
    <Routes>
      {/* Routes that don't need a bearer token. The polling page
          calls `/oauth/authorize/:id` directly (cookie-driven),
          and device-entry just navigates. */}
      <Route path="/oauth-polling/:id" element={<OAuthPollingScreen />} />
      <Route path="/devices" element={<DeviceEntryScreen />} />

      {/* All Owner-facing screens go through the auth gate so
          descendant `useGatekeeperClient()` calls always see a real
          session. */}
      <Route element={<GatekeeperAuthorizedRoutes />}>
        <Route path="/" element={<AccessIndexScreen />} />
        <Route path="/requests" element={<RequestsListScreen />} />
        <Route path="/requests/:id" element={<RequestDetailScreen />} />
        <Route path="/approved/:id" element={<ApprovedAppDetailScreen />} />
        <Route path="/oauth-consent/:id" element={<OAuthConsentScreen />} />
        <Route path="/devices/:userCode" element={<DeviceConsentScreen />} />
      </Route>
    </Routes>
  </>
)

export { App }
