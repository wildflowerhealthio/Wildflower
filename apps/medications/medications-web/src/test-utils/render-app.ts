import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createElement, type JSX, StrictMode } from 'react'

import { App } from '../app.tsx'
import { BASEPATH } from './app-fakes.ts'

/** What {@link renderApp} hands the test. */
interface RenderedApp {
  /** Render the app again, as a change to the handshake's state would. */
  readonly rerenderApp: () => void
}

/**
 * Render `App` under StrictMode over a retry-free client (fast failures), at
 * `route` under {@link BASEPATH} (the app root by default).
 */
const renderApp = ({ route = '' }: { readonly route?: string } = {}): RenderedApp => {
  window.history.replaceState(null, '', `${BASEPATH}${route}`)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const app = (): JSX.Element =>
    createElement(
      StrictMode,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(App, { basepath: BASEPATH })
      )
    )
  const { rerender } = render(app())
  return {
    rerenderApp: () => {
      rerender(app())
    },
  }
}

export { renderApp, type RenderedApp }
