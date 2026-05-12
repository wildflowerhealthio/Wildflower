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
// "[X] is not a <Route>". Paths hardcode the /gatekeeper prefix so they
// match `gatekeeper-core/page-paths` under both MemoryRouter and
// BrowserRouter without basename gymnastics; the drift test in
// tests/routes.test.tsx asserts each redirect target has a matching
// <Route>.
//
// The fragments are split because authentication wraps only a subset:
// public routes need an unauthenticated client (OAuth device flow,
// polling); authorized routes need the live bearer token, supplied by
// `<AuthorizedAppShell>` in the app composing both fragments.

/** Public routes — no bearer token required. */
const gatekeeperPublicRoutesFragment: JSX.Element = (
  <>
    <Route path="/gatekeeper/oauth-polling/:id" element={<OAuthPollingScreen />} />
    <Route path="/gatekeeper/devices" element={<DeviceEntryScreen />} />
  </>
)

/**
 * Owner-facing routes — require a bearer token. The app mounts these as
 * children of a `<Route element={<AuthorizedAppShell />}>` so the shell
 * can re-provide `<GatekeeperClientProvider>` with the live token.
 */
const gatekeeperAuthorizedRoutesFragment: JSX.Element = (
  <>
    <Route path="/gatekeeper" element={<AccessIndexScreen />} />
    <Route path="/gatekeeper/requests" element={<RequestsListScreen />} />
    <Route path="/gatekeeper/requests/:id" element={<RequestDetailScreen />} />
    <Route path="/gatekeeper/approved/:id" element={<ApprovedAppDetailScreen />} />
    <Route path="/gatekeeper/oauth-consent/:id" element={<OAuthConsentScreen />} />
    <Route path="/gatekeeper/devices/:userCode" element={<DeviceConsentScreen />} />
  </>
)

export { gatekeeperPublicRoutesFragment, gatekeeperAuthorizedRoutesFragment }
