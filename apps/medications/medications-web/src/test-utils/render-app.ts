import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserHistory, type RouterHistory } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { createElement, type JSX, StrictMode } from 'react'
import { onTestFinished } from 'vite-plus/test'

import { SignInLandingContext } from '@wildflowerhealthio/smart-app-react'

import { App } from '../app.tsx'
import { BASEPATH, signInLanding } from './app-fakes.ts'

/** What {@link renderApp} hands the test. */
interface RenderedApp {
  /** Render the app again, as a change to the handshake's state would. */
  readonly rerenderApp: () => void
  /** The page's history, which the router navigates. */
  readonly history: RouterHistory
}

/**
 * Render `App` under StrictMode over a retry-free client (fast failures), on
 * the sign-in landing the app root would hand it, at
 * `route` under {@link BASEPATH} (the app root by default), over a browser
 * history the test destroys as it finishes, as a page would never need to.
 */
const renderApp = ({ route = '' }: { readonly route?: string } = {}): RenderedApp => {
  window.history.replaceState(null, '', `${BASEPATH}${route}`)
  const history = createBrowserHistory()
  onTestFinished(() => {
    history.destroy()
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const app = (): JSX.Element =>
    createElement(
      StrictMode,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          SignInLandingContext,
          { value: signInLanding },
          createElement(App, { page: { basepath: BASEPATH, history } })
        )
      )
    )
  const { rerender } = render(app())
  return {
    rerenderApp: () => {
      rerender(app())
    },
    history,
  }
}

export { renderApp, type RenderedApp }
