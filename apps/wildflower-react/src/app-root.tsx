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

type WrapperComponent = ComponentType<{ readonly children?: ReactNode }>
interface RenderAppOptions {
  /** Browser history for web, memory history for embedded WebView. */
  readonly history: RouterHistory
  readonly TransportProvider: WrapperComponent
  /** Tagged onto Sentry events to distinguish web/embedded crashes. */
  readonly entry: 'main-web' | 'main-embedded' | 'main-single-web'
}

/**
 * Mount the app under `#root`. Called once per entry point.
 *
 * The same `QueryClient` is given to both `<QueryClientProvider>` and
 * `createRouter`'s `context`, so loaders' `ensureQueryData` and
 * components' `useQuery` share one cache. Cache is in-memory only — no
 * persister; warm via preloading.
 *
 * Slice client providers live in `RootShell` (root route component),
 * not wrapping `<RouterProvider>` — it doesn't accept children.
 */
const renderApp = ({ history, TransportProvider, entry }: RenderAppOptions): void => {
  const { queryClient, runAuthed, runtimeLayer } = buildAppQueryRuntime()
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient, runAuthed, runtimeLayer },
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
