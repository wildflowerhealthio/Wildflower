import { createRouter, type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-tundraish'
import { Sentry } from 'telemetry-web'

import { routeTree } from './routeTree.gen.ts'

interface RenderAppOptions {
  /**
   * TanStack history instance: `createBrowserHistory()` for the
   * standalone web build, `createMemoryHistory()` for the embedded
   * WebView build.
   */
  readonly history: RouterHistory
  /**
   * Entry-point label forwarded to the ErrorBoundary's `extraContext` so
   * Sentry events distinguish web-vs-embedded crashes.
   */
  readonly entry: 'main-web' | 'main-embedded'
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
const renderApp = ({ history, entry }: RenderAppOptions): void => {
  const router = createRouter({ routeTree, history })
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
        <RouterProvider router={router} />
      </ErrorBoundary>
    </StrictMode>
  )
}

export { renderApp }
export type { RenderAppOptions }
