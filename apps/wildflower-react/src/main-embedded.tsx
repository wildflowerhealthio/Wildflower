import './instrument.ts'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// See `main-web.tsx` for the provider-stack rationale.
AppRoot.render(
  <MemoryRouter>
    <AuthTokenProvider subscribable={authTokenRef}>
      <TransportProvider>
        <GatekeeperClientProvider>
          <Routes>{appRoutesFragment}</Routes>
        </GatekeeperClientProvider>
      </TransportProvider>
    </AuthTokenProvider>
  </MemoryRouter>
)
