import { createRouter, type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { StrictMode, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-tundraish'
import { Sentry } from 'telemetry-web'

import { AppsRuntimeProvider } from 'apps-react'
import { CollectorRuntimeProvider } from 'collector-react'
import { authTokenRef } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { AppsSenderForwarder } from './bridges/apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { QueryClientPersistProvider } from './bridges/query-client-persist-provider.tsx'
import { buildQueryClient } from './bridges/router-context.ts'
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
 */
const renderApp = ({ history, TransportProvider, entry }: RenderAppOptions): void => {
  const queryClient = buildQueryClient()
  const router = createRouter({ routeTree, history, context: { queryClient } })
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
