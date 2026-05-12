import './instrument.ts'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// `<AuthTokenProvider>` makes the gatekeeper-react module-scoped
// `authTokenRef` (a `SubscriptionRef<string | null>` syncing with
// localStorage) available to `<GatekeeperClientProvider>` and any
// other auth-aware code. The slice's client layer reads the live token
// per-request via the `BearerToken` service, so rotation surfaces
// without remounting the provider.
AppRoot.render(
  <BrowserRouter>
    <AuthTokenProvider subscribable={authTokenRef}>
      <TransportProvider>
        <GatekeeperClientProvider>
          <Routes>{appRoutesFragment}</Routes>
        </GatekeeperClientProvider>
      </TransportProvider>
    </AuthTokenProvider>
  </BrowserRouter>
)
