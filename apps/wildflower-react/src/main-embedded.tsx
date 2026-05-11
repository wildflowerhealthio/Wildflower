import './instrument.ts'
import { GatekeeperClientProvider } from 'gatekeeper-react'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// Root client provider is unauthenticated; `<AuthorizedAppShell>` re-provides
// with the live token inside the protected subtree so every owner-facing
// route gets a bearer-attached client through the same `useGatekeeperClient()`
// hook.
AppRoot.render(
  <MemoryRouter>
    <TransportProvider>
      <GatekeeperClientProvider token={null}>
        <Routes>{appRoutesFragment}</Routes>
      </GatekeeperClientProvider>
    </TransportProvider>
  </MemoryRouter>
)
