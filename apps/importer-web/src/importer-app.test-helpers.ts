import { createBrowserHistory } from '@tanstack/react-router'
import type { SmartAppPage } from '@wildflowerhealthio/smart-app-react'
import { onTestFinished, vi } from 'vite-plus/test'

/** The directory the app is served from in these tests. */
const BASEPATH = '/importer/'

/**
 * A `ResizeObserver` that never fires: jsdom has no layout, and nothing these
 * tests check hangs on a resize (the page's `RouteTabs` observes its strip).
 */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** `Element.scrollTo` as it was before each test, which jsdom leaves undefined. */
const scrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')

/**
 * Stub the browser APIs the page's router and `RouteTabs` read that jsdom
 * lacks (`window.scrollTo`, which the router resets the scroll with on each
 * navigation, `ResizeObserver`, `matchMedia`, `Element.scrollTo`); undone by
 * {@link restorePageBrowserApis}.
 */
const stubPageBrowserApis = (): void => {
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('ResizeObserver', InertResizeObserver)
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }))
  Element.prototype.scrollTo = () => {}
}

/** Put back what {@link stubPageBrowserApis} stubbed, and every other stubbed global. */
const restorePageBrowserApis = (): void => {
  vi.unstubAllGlobals()
  if (scrollToDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollTo')
  else Object.defineProperty(Element.prototype, 'scrollTo', scrollToDescriptor)
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

export { BASEPATH, currentRoute, pageAt, restorePageBrowserApis, stubPageBrowserApis }
