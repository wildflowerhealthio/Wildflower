import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { StrictMode, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-tundraish'
import { Sentry } from 'telemetry-web'

import { AppsRuntimeProvider } from 'apps-react'
import { CollectorRuntimeProvider } from 'collector-react'
import { authTokenRef } from 'gatekeeper-react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { buildAppQueryRuntime } from './bridges/app-query-runtime.ts'
import { AppsSenderForwarder } from './bridges/apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './bridges/collector-sender-forwarder.tsx'
import { prefetchKeyRoutes } from './bridges/prefetch-key-routes.ts'
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
 * Mount the full wildflower-react app shell — error boundary, the
 * in-memory query client, router, provider stack, and route tree — under
 * `#root`, wrapped in `<StrictMode>`. Called once per entry point
 * (`main-web.tsx`, `main-single-web.tsx`, `main-embedded.tsx`) with the
 * appropriate history and entry label.
 *
 * @remarks
 * A single in-memory `QueryClient` (built by {@link buildAppQueryRuntime})
 * is shared two ways: it is passed to `createRouter`'s typed `context`
 * (so route `loader`s prefetch via
 * `context.queryClient.ensureQueryData(...)`) AND handed to a plain
 * `<QueryClientProvider>` (from `@tanstack/react-query`) that wraps the
 * entire tree — including `<RouterProvider>` — so every `useQuery` /
 * `useMutation` / `useSuspenseQuery` in a slice resolves the same client.
 * This is an IN-MEMORY client: there is no localStorage persister, by
 * design (the deliberate alternative to PR #99). The warm-cache mechanism
 * is route PRELOADING — `defaultPreload: 'intent'` plus loader
 * `ensureQueryData` plus {@link prefetchKeyRoutes} — not storage restore.
 *
 * Alongside the `QueryClient`, {@link buildAppQueryRuntime} also builds a
 * long-lived authed runner exposed to the router context as `runAuthed`.
 * Route `loader`s run outside React, so they can't use the React-provided
 * bearer token or the React-composed slice client layers; `runAuthed`
 * supplies the shared `BearerToken` + `HttpClient.HttpClient` environment
 * (the same `authTokenRef` the React tree reads through
 * `<AuthTokenProvider>`, and the same `webHttpClientLayer` every slice
 * client uses), while each slice loader still provides its own client
 * layer.
 *
 * The slice client providers live inside `routeTree`'s root component
 * (`RootShell`) rather than wrapping `<RouterProvider>`, because
 * TanStack's `<RouterProvider>` does not accept children — child routes
 * are mounted via the root's `<Outlet />`.
 */
const renderApp = ({ history, TransportProvider, entry }: RenderAppOptions): void => {
  // The shared in-memory query client + the long-lived authed runner for
  // route loaders. Both are page-scoped and built once per entry; see
  // `buildAppQueryRuntime`.
  const { queryClient, runAuthed } = buildAppQueryRuntime()
  // `defaultPreload: 'intent'` warms a route's loader on hover/focus so
  // the in-memory cache is primed before the user clicks — the
  // navigation-time analogue of the eager startup prefetch below.
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient, runAuthed },
    defaultPreload: 'intent',
  })
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('root element not found')
  }
  prefetchKeyRoutes(queryClient, runAuthed)
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
        <QueryClientProvider client={queryClient}>
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
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}

export { renderApp }
export type { RenderAppOptions }
