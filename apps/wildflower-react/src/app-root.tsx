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
import { routeTree } from './routeTree.gen.ts'

/**
 * Props passed to the chosen router component (`BrowserRouter` for the
 * standalone web build, `MemoryRouter` for the embedded WebView build).
 * Typed as `{ children?: ReactNode }` because that's the only prop the
 * app shell forwards — we don't need the full `BrowserRouterProps`
 * surface from `react-router`.
 */
type WrapperComponent = ComponentType<{ readonly children?: ReactNode }>
interface RenderAppOptions {
  /**
   * TanStack history instance: `createBrowserHistory()` for the
   * standalone web build, `createMemoryHistory()` for the embedded
   * WebView build.
   */
  readonly history: RouterHistory
  /** Router component to wrap the route tree. */
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
 * The provider stack lives inside `routeTree`'s root component
 * (`RootShell`) rather than wrapping `<RouterProvider>`, because
 * TanStack's `<RouterProvider>` does not accept children — child routes
 * are mounted via the root's `<Outlet />`.
 */
const renderApp = ({ history, TransportProvider, entry }: RenderAppOptions): void => {
  const router = createRouter({ routeTree, history })
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
      </ErrorBoundary>
    </StrictMode>
  )
}

export { renderApp }
export type { RenderAppOptions }
