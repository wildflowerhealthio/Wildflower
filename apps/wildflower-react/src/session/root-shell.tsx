import { Outlet } from '@tanstack/react-router'
import { AppsClientProvider, AppsRuntimeProvider } from 'apps-react'
import { CollectorClientProvider, CollectorRuntimeProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import type { JSX } from 'react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { TunnelClientProvider } from 'tunnel-react'

import { AppsSenderForwarder } from '../bridges/apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from '../bridges/collector-sender-forwarder.tsx'
import { QueryClientPersistProvider } from '../bridges/query-client-persist-provider.tsx'
import { TransportProvider } from '../bridges/transport-provider.tsx'

// Mount order:
//  1. `<AuthTokenProvider>` exposes the gatekeeper-react module-scoped
//     `authTokenRef` (a `SubscriptionRef<string | null>` syncing with
//     localStorage) to every slice's client layer below it. All five
//     slice client providers (gatekeeper, collector, fhir-r4, apps,
//     tunnel) read the live token per-request via the `BearerToken`
//     service, so rotation surfaces without remounting any provider.
//  2. `<CollectorRuntimeProvider>` exposes the CollectorBridge `Web`
//     receiver layer + the active-handler ref the running sync installs
//     into; mounted before the transport builds.
//  2b. `<AppsRuntimeProvider>` exposes the AppsBridge `Web` receiver
//     layer + the pending-tunnel-resolver ref `useRequestTunnel`
//     installs into; mounted before the transport builds.
//  3. `<TransportProvider>` builds the BridgeTransport using
//     collector's + apps' receiver layers via context and hosts it via
//     TransportContext.
//  4. `<CollectorSenderForwarder>` reads `transport.sendMessage` and
//     surfaces it to collector-react screens via CollectorSenderProvider.
//  4b. `<AppsSenderForwarder>` does the same for the apps slice.
//  5. The slice client providers each put a slice's client layer in
//     context; the admin layers read the live token from `BearerToken`
//     per request. `<AppsClientProvider>` provides BOTH the public and
//     admin apps client layers.
//  5b. `<TunnelClientProvider>` provides the tunnel slice's admin
//     client layer. It takes no props — the layer reads the live token
//     from `BearerToken` per request, like the other slice client
//     providers. Tunnel has no public counterpart (owner-only API).
//  6. `<QueryClientPersistProvider>` mounts the TanStack Query client +
//     localStorage persister. Sits innermost so the slice client
//     providers are already wired by the time any query function runs
//     against them. Caches every GET, hydrates from localStorage on
//     mount, and refetches in the background (staleTime: 0).
/**
 * Root route component rendered inside TanStack `<RouterProvider>`.
 * Hosts the full provider stack and renders `<Outlet />` so the matched
 * child route mounts under the providers.
 */
const RootShell = (): JSX.Element => (
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
                        <QueryClientPersistProvider>
                          <Outlet />
                        </QueryClientPersistProvider>
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
)

export { RootShell }
