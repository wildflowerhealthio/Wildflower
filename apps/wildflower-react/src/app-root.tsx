import { createRouter, type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { StrictMode, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-tundraish'
import { webHttpClientLayer } from 'telemetry-react'
import { Sentry } from 'telemetry-web'

import { AppsRuntimeProvider } from 'apps-react'
import { CollectorRuntimeProvider } from 'collector-react'
import { authTokenRef } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { AppsSenderForwarder } from './bridges/apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { QueryClientPersistProvider } from './bridges/query-client-persist-provider.tsx'
import { buildQueryClient, buildRunAuthed } from './bridges/router-context.ts'
import { routeTree } from './routeTree.gen.ts'

/**
 * A per-entry transport wrapper component mounted inside the router's
 * `InnerWrap`. Typed as `{ children?: ReactNode }` because forwarding
 * children is the only contract the app shell needs — the concrete
 * implementation (live vs. stub transport) varies per entry point.
 */
type WrapperComponent = ComponentType<{ readonly children?: ReactNode }>
interface RenderAppOptions {
  /**
   * TanStack history instance: `createBrowserHistory()` for the
   * standalone web build, `createMemoryHistory()` for the embedded
   * WebView build.
   */
  readonly history: RouterHistory
  /** Transport wrapper mounted inside the router's `InnerWrap`. */
  readonly TransportProvider: WrapperComponent
  /**
   * Entry-point label forwarded to the ErrorBoundary's `extraContext` so
   * Sentry events distinguish web-vs-embedded crashes.
   */
  readonly entry: 'main-web' | 'main-embedded' | 'main-single-web'
}

/**
 * Mount the full wildflower-react app shell — error boundary, router,
 * provider stack, and route tree — under `#root`, wrapped in
 * `<StrictMode>`. Called once per entry point (`main-web.tsx` and
 * `main-embedded.tsx`) with the appropriate history and entry label.
 *
 * @remarks
 * A single {@link buildQueryClient} instance is created here and shared
 * two ways: it is passed to `createRouter`'s typed `context` (so route
 * `loader`s can prefetch via `context.queryClient.ensureQueryData(...)`)
 * AND handed to `<QueryClientPersistProvider>`, which wraps the entire
 * tree — including `<RouterProvider>` — so every `useQuery` /
 * `useMutation` in a slice resolves the same client and the localStorage
 * persister is active app-wide.
 *
 * The slice client providers live inside `routeTree`'s root component
 * (`RootShell`) rather than wrapping `<RouterProvider>`, because
 * TanStack's `<RouterProvider>` does not accept children — child routes
 * are mounted via the root's `<Outlet />`.
 *
 * Alongside the `QueryClient`, a long-lived authed runner is built via
 * {@link buildRunAuthed} and exposed to the router context as
 * `runAuthed`. Route `loader`s run outside React, so they can't use the
 * React-provided bearer token or the React-composed slice client layers;
 * `runAuthed` supplies the shared `BearerToken` + `HttpClient.HttpClient`
 * environment (the same `authTokenRef` the React tree reads through
 * `<AuthTokenProvider>`, and the same `webHttpClientLayer` every slice
 * client uses), while each slice loader still provides its own client
 * layer. The runtime is app-scoped and lives for the page's lifetime —
 * there is no `renderApp` teardown hook to dispose against, which matches
 * the page-lifetime `authTokenRef` it closes over.
 *
 * @remarks
 * The HTTP transport is the same `webHttpClientLayer` (browser `fetch` +
 * web telemetry) for every entry point. The embedded WebView build
 * differs only in its `BridgeTransport` (navigation / gatekeeper /
 * collector / logging messaging), NOT in how slice HTTP clients reach the
 * network — those always go over `fetch` against `baseUrl: '/'`. So a
 * single authed runtime layer is correct across `main-web`,
 * `main-single-web`, and `main-embedded`.
 */
const renderApp = ({ history, TransportProvider, entry }: RenderAppOptions): void => {
  const queryClient = buildQueryClient()
  // Long-lived authed runner for route loaders: provides `BearerToken`
  // (from the page-lifetime `authTokenRef` the React tree also reads) over
  // the same `webHttpClientLayer` every slice client uses. The runtime is
  // app-scoped and lives for the page's lifetime; `renderApp` has no
  // teardown hook to dispose against, which matches `authTokenRef`.
  const { runAuthed } = buildRunAuthed(authTokenRef, webHttpClientLayer)
  const router = createRouter({ routeTree, history, context: { queryClient, runAuthed } })
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('root element not found')
  }
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary
        onError={(error, info) => {
          console.error(`[${entry}] Uncaught error:`, error, info)
          Sentry.captureException(error, {
            extra: { componentStack: info.componentStack ?? undefined },
          })
        }}
        extraContext={{
          mode: import.meta.env.MODE,
          entry,
        }}
      >
        <QueryClientPersistProvider queryClient={queryClient}>
          <AuthTokenProvider subscribable={authTokenRef}>
            <RouterProvider
              router={router}
              InnerWrap={({ children }) => {
                return (
                  <CollectorRuntimeProvider>
                    <AppsRuntimeProvider>
                      <TransportProvider>
                        <CollectorSenderForwarder>
                          <AppsSenderForwarder>{children}</AppsSenderForwarder>
                        </CollectorSenderForwarder>
                      </TransportProvider>
                    </AppsRuntimeProvider>
                  </CollectorRuntimeProvider>
                )
              }}
            />
          </AuthTokenProvider>
        </QueryClientPersistProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}

export { renderApp }
export type { RenderAppOptions }
