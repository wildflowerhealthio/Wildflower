import { AppsClientProvider, AppsRuntimeProvider } from 'apps-react'
import { CollectorClientProvider, CollectorRuntimeProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { authTokenRef, GatekeeperClientProvider } from 'gatekeeper-react'
import { type ComponentType, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { Routes } from 'react-router'
import { ErrorBoundary } from 'react-tundraish'
import { Sentry } from 'telemetry-web'
import { TunnelClientProvider } from 'tunnel-react'

import { AppsSenderForwarder } from './bridges/apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'

/**
 * Props passed to the chosen router component (`BrowserRouter` for the
 * standalone web build, `MemoryRouter` for the embedded WebView build).
 * Typed as `{ children?: ReactNode }` because that's the only prop the
 * app shell forwards — we don't need the full `BrowserRouterProps`
 * surface from `react-router`.
 */
type Router = ComponentType<{ readonly children?: ReactNode }>

interface RenderAppOptions {
  /** Router component to wrap the route tree. */
  readonly Router: Router
  /**
   * Entry-point label forwarded to the ErrorBoundary's `extraContext` so
   * Sentry events distinguish web-vs-embedded crashes.
   */
  readonly entry: 'main-web' | 'main-embedded'
}

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
/**
 * Mount the full wildflower-react app shell — error boundary, router,
 * provider stack, and route tree — under `#root`, wrapped in
 * `<StrictMode>`. Called once per entry point (`main-web.tsx` and
 * `main-embedded.tsx`) with the appropriate router and entry label.
 */
const renderApp = ({ Router, entry }: RenderAppOptions): void => {
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('root element not found')
  }
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary
        onError={(error, info) =>
          Sentry.captureException(error, {
            extra: { componentStack: info.componentStack ?? undefined },
          })
        }
        extraContext={{
          mode: import.meta.env.MODE,
          entry,
        }}
      >
        <Router>
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
        </Router>
      </ErrorBoundary>
    </StrictMode>
  )
}

export { renderApp }
export type { RenderAppOptions }
