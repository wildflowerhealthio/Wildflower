import { createBrowserHistory } from '@tanstack/react-router'
import { stubRouteTabsBrowserApis } from '@wildflowerhealthio/react-tundraish/test-helpers'
import type { SmartAppPage } from '@wildflowerhealthio/smart-app-react'
import { onTestFinished, vi } from 'vite-plus/test'

/** The directory the app is served from in these tests. */
const BASEPATH = '/importer/'

/**
 * Stub the browser APIs the page reads that jsdom lacks: `window.scrollTo`,
 * which the router resets the scroll with on each navigation, and those
 * `RouteTabs` reads (`react-tundraish/test-helpers`).
 *
 * @returns Put them back, and every other stubbed global: a `beforeEach`
 *   returns it, so it runs as the test finishes.
 */
const stubPageBrowserApis = (): (() => void) => {
  vi.stubGlobal('scrollTo', () => {})
  const restoreRouteTabsBrowserApis = stubRouteTabsBrowserApis()
  return () => {
    vi.unstubAllGlobals()
    restoreRouteTabsBrowserApis()
  }
}

/**
 * Put `route` under {@link BASEPATH} in the address bar, and hand back the
 * page over it: a browser history the test destroys as it finishes (as a page
 * would never need to), under {@link BASEPATH}.
 */
const pageAt = (route: string): SmartAppPage => {
  window.history.replaceState(null, '', `${BASEPATH}${route}`)
  const history = createBrowserHistory()
  onTestFinished(() => {
    history.destroy()
  })
  return { history, basepath: BASEPATH }
}

/** The address bar's path under {@link BASEPATH}. */
const currentRoute = (): string => window.location.pathname.slice(BASEPATH.length)

export { BASEPATH, currentRoute, pageAt, stubPageBrowserApis }
