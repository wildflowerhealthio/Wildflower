import './instrument.ts'
import { AppsClientProvider, AppsRuntimeProvider } from 'apps-react'
import { CollectorClientProvider, CollectorRuntimeProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { TunnelClientProvider } from 'tunnel-react'
import * as AppRoot from './app-root.tsx'
import { AppsSenderForwarder } from './bridges/apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// See `main-web.tsx` for the provider-stack rationale.
AppRoot.render(
  <MemoryRouter>
    <AuthTokenProvider subscribable={authTokenRef}>
      <CollectorRuntimeProvider>
        <AppsRuntimeProvider>
          <TransportProvider>
            <CollectorSenderForwarder>
              <AppsSenderForwarder>
                <GatekeeperClientProvider>
                  <CollectorClientProvider>
                    <FhirR4ResourcesClientProvider>
                      <AppsClientProvider>
                        <TunnelClientProvider>
                          <Routes>{appRoutesFragment}</Routes>
                        </TunnelClientProvider>
                      </AppsClientProvider>
                    </FhirR4ResourcesClientProvider>
                  </CollectorClientProvider>
                </GatekeeperClientProvider>
              </AppsSenderForwarder>
            </CollectorSenderForwarder>
          </TransportProvider>
        </AppsRuntimeProvider>
      </CollectorRuntimeProvider>
    </AuthTokenProvider>
  </MemoryRouter>
)
