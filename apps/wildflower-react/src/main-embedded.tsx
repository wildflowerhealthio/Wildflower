import './instrument.ts'
import { CollectorClientProvider, CollectorRuntimeProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// See `main-web.tsx` for the provider-stack rationale.
AppRoot.render(
  <MemoryRouter>
    <AuthTokenProvider subscribable={authTokenRef}>
      <CollectorRuntimeProvider>
        <TransportProvider>
          <CollectorSenderForwarder>
            <GatekeeperClientProvider>
              <CollectorClientProvider>
                <FhirR4ResourcesClientProvider>
                  <Routes>{appRoutesFragment}</Routes>
                </FhirR4ResourcesClientProvider>
              </CollectorClientProvider>
            </GatekeeperClientProvider>
          </CollectorSenderForwarder>
        </TransportProvider>
      </CollectorRuntimeProvider>
    </AuthTokenProvider>
  </MemoryRouter>
)
