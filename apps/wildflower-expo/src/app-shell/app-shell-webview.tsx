import { BridgedWebView } from 'effect-messaging-expo'
import * as SplashScreen from 'expo-splash-screen'
import { Loader } from 'expo-tundraish'
import { localOrigin$ } from 'local-http-server-core/livestore'
import { useCallback, useMemo, type JSX } from 'react'
import { html } from 'wildflower-react/embeddable-html'
import { tabForPath } from '@/src/components/tab-mapping.ts'
import { useWildflowerStore } from '../livestore/livestore-store.ts'
import { useHostBindings } from './use-host-bindings.ts'

interface AppShellWebViewProps {
  /** Fires every time the SPA emits `RouteChanged`. */
  readonly onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
}

const makeShouldOpenInSystemBrowser =
  (loopbackBaseUrl: string) =>
  (urlString: string): boolean => {
    try {
      const url = new URL(urlString)
      const loopbackUrl = new URL(loopbackBaseUrl)

      if (url.origin !== loopbackUrl.origin) return true
      const isRootPath = url.pathname === '' || url.pathname === '/'
      const isTabbedPath = tabForPath(url.pathname) !== null
      if (isRootPath || isTabbedPath) return false

      return true
    } catch {
      // Conservative: malformed WebView-supplied URL → open in system browser.
      return true
    }
  }

/**
 * The persistent shell that hosts the wildflower-react SPA. Aggregates
 * one host binding per slice and hands the tuple to {@link BridgedWebView}.
 *
 * Wires the navigation binding's `onTransportReady` into the surrounding
 * {@link useAsNavigationOutlet} pipe, so a sibling tab bar can dispatch
 * `HostRequestedWebNavigation` through the same transport.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
const AppShellWebView = ({ onRouteChanged }: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  // The embedded SPA always loads against the loopback origin so its
  // API calls hit `127.0.0.1` directly.
  const loopbackBaseUrl = store.useQuery(localOrigin$)
  const loadFrom = useMemo(
    () => ({ _tag: 'html', html, baseUrl: loopbackBaseUrl }) as const,
    [loopbackBaseUrl]
  )
  const shouldOpenInSystemBrowser = useMemo(
    () => makeShouldOpenInSystemBrowser(loopbackBaseUrl),
    [loopbackBaseUrl]
  )
  // Reveal the native UI when the SPA reports `UIReady` (auth gate
  // passed + startup prefetches settled). `hideAsync` rejects when the
  // splash is already hidden (e.g. the `prevent-splash-hide` fallback
  // timer fired first); swallow that so a late `UIReady` doesn't crash.
  const handleUiReady = useCallback(() => {
    void SplashScreen.hideAsync().catch(() => undefined)
  }, [])
  // Memoize the tuple so `BridgedWebView`'s transport doesn't rebuild on
  // every render — the component's contract requires stable `bindings`
  // identity (see its TSDoc). Bridge ordering matches the page-side
  // tuple in `wildflower-react`'s transport provider.
  const bindings = useHostBindings({ onRouteChanged, onUIReady: handleUiReady })

  return (
    <BridgedWebView
      bindings={bindings}
      loadFrom={loadFrom}
      loader={<Loader />}
      shouldOpenInSystemBrowser={shouldOpenInSystemBrowser}
    />
  )
}

export { AppShellWebView }
export type { AppShellWebViewProps }
