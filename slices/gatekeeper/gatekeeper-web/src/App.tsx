import type { JSX } from 'react'
import { Route, Routes } from 'react-router'
import { HostBridge } from './host-bridge.tsx'
import { AccessIndexScreen } from './screens/access-index.tsx'
import { ApprovedAppDetailScreen } from './screens/approved-app-detail.tsx'
import { AuthorizationRequestScreen } from './screens/authorization-request.tsx'
import { RequestDetailScreen } from './screens/request-detail.tsx'
import { RequestsListScreen } from './screens/requests-list.tsx'

const App = (): JSX.Element => (
  <>
    <HostBridge />
    <Routes>
      <Route path="/" element={<AccessIndexScreen />} />
      <Route path="/requests" element={<RequestsListScreen />} />
      <Route path="/requests/:id" element={<RequestDetailScreen />} />
      <Route path="/approved/:id" element={<ApprovedAppDetailScreen />} />
      <Route path="/authorization_request/:id" element={<AuthorizationRequestScreen />} />
    </Routes>
  </>
)

export { App }
