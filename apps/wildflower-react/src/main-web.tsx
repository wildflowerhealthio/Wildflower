import './instrument.ts'
import { AppsClientProvider } from 'apps-react'
import { CollectorClientProvider, CollectorRuntimeProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// Mount order:
//  1. `<AuthTokenProvider>` exposes the gatekeeper-react module-scoped
//     `authTokenRef` (a `SubscriptionRef<string | null>` syncing with
//     localStorage) to every slice's client layer below it. All four
//     slice client providers (gatekeeper, collector, fhir-r4, apps)
//     read the live token per-request via the `BearerToken` service,
//     so rotation surfaces without remounting any provider.
//  2. `<CollectorRuntimeProvider>` exposes the CollectorBridge `Web`
//     receiver layer + the active-handler ref the running sync installs
//     into; mounted before the transport builds.
//  3. `<TransportProvider>` builds the BridgeTransport using collector's
//     receiver layer via context and hosts it via TransportContext.
//  4. `<CollectorSenderForwarder>` reads `transport.sendMessage` and
//     surfaces it to collector-react screens via CollectorSenderProvider.
//  5. The four tokenless client providers each put a slice's client
//     layer in context; each reads the live token from `BearerToken`
//     per request.
AppRoot.render(
  <BrowserRouter>
    <AuthTokenProvider subscribable={authTokenRef}>
      <CollectorRuntimeProvider>
        <TransportProvider>
          <CollectorSenderForwarder>
            <GatekeeperClientProvider>
              <CollectorClientProvider>
                <FhirR4ResourcesClientProvider>
                  <AppsClientProvider>
                    <Routes>{appRoutesFragment}</Routes>
                  </AppsClientProvider>
                </FhirR4ResourcesClientProvider>
              </CollectorClientProvider>
            </GatekeeperClientProvider>
          </CollectorSenderForwarder>
        </TransportProvider>
      </CollectorRuntimeProvider>
    </AuthTokenProvider>
  </BrowserRouter>
)
