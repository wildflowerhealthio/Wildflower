import { BridgedWebView } from 'effect-messaging-expo'
import * as SplashScreen from 'expo-splash-screen'
import { localOrigin$ } from 'local-http-server-core/livestore'
import { useCallback, useMemo, useState, type JSX } from 'react'
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes'
import { html } from 'wildflower-react/embeddable-html'
import { tabForPath } from '@/src/components/tab-mapping.ts'
import { useWildflowerStore } from '../livestore/livestore-store.ts'
import { DevServerUnreachable } from './dev-server-unreachable.tsx'
import { useHostBindings } from './use-host-bindings.ts'

interface AppShellWebViewProps {
  /** Fires every time the SPA emits `RouteChanged`. */
  readonly onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
}

const makeShouldOpenInSystemBrowser =
  (pageOrigin: string) =>
  (urlString: string): boolean => {
    try {
      const url = new URL(urlString)
      const pageUrl = new URL(pageOrigin)

      if (url.origin !== pageUrl.origin) return true
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
 * Wires the navigation binding's `onPageReady` into the surrounding
 * navigation pipe's sender ref, so a sibling tab bar can dispatch
 * `HostRequestedWebNavigation` through the same transport.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
const AppShellWebView = ({ onRouteChanged }: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  // Opt-in dev override: when set in a `__DEV__` build, the WebView loads the
  // SPA from this URL (a laptop dev server, for hot reload) instead of the
  // embedded HTML bundle. Expo statically inlines both `__DEV__` and the
  // `process.env.EXPO_PUBLIC_*` token, so this is a build-time constant in
  // release builds (`undefined`, which always load the embedded bundle); it
  // lives in the render body only so it stays controllable under test. The
  // SPA's API calls are re-pointed back to the in-app loopback origin via
  // `HostApiOriginChanged` (see `use-navigation-host-binding.ts`), so it
  // still talks to `127.0.0.1` even though its page is served from elsewhere.
  const devSpaUrl = __DEV__ ? process.env.EXPO_PUBLIC_DEV_SPA_URL : undefined
  // The default build loads the embedded bundle against the loopback
  // origin so its API calls hit `127.0.0.1` directly. A dev build can
  // instead load the SPA from `devSpaUrl`; either way the API origin
  // pushed to the page is always the loopback one.
  const loopbackBaseUrl = store.useQuery(localOrigin$)

  // Failed-load event from react-native-webview's `onError` (dev-SPA mode
  // only). Non-null → the dev server is unreachable; render the loud
  // fallback instead of a blank/native-error WebView.
  const [loadError, setLoadError] = useState<WebViewErrorEvent | null>(null)

  const loadFrom = useMemo(
    () =>
      devSpaUrl !== undefined
        ? ({ _tag: 'uri', uri: devSpaUrl } as const)
        : ({ _tag: 'html', html, baseUrl: loopbackBaseUrl } as const),
    [loopbackBaseUrl, devSpaUrl]
  )
  // The page's own origin: the dev server in dev-SPA mode, the loopback
  // origin otherwise. Drives which navigations stay in-WebView.
  const pageOrigin = devSpaUrl ?? loopbackBaseUrl
  const shouldOpenInSystemBrowser = useMemo(
    () => makeShouldOpenInSystemBrowser(pageOrigin),
    [pageOrigin]
  )
  // The loopback API origin the SPA must target, normalized (scheme +
  // host + port, no trailing slash) for the `HostApiOriginChanged` push.
  const apiOrigin = useMemo(() => new URL(loopbackBaseUrl).origin, [loopbackBaseUrl])

  // The WebView mounts under the native splash with no JS loader; the
  // splash stays up until the page reports its first paint via `UIReady`,
  // avoiding a blank/loader flash during bundle load. Swallow the
  // rejection so a hide failure (e.g. splash already hidden by the 10s
  // fallback in `prevent-splash-hide.ts`) can't escape as an unhandled
  // rejection, but log so it stays visible in telemetry.
  const handleUiReady = useCallback(() => {
    void SplashScreen.hideAsync().catch((cause: unknown) => {
      // oxlint-disable-next-line no-console
      console.warn('SplashScreen.hideAsync failed on UIReady', cause)
    })
  }, [])
  // Memoize the tuple so `BridgedWebView`'s transport doesn't rebuild on
  // every render — the component's contract requires stable `bindings`
  // identity (see its TSDoc). Bridge ordering matches the page-side
  // tuple in `wildflower-react`'s transport provider.
  const bindings = useHostBindings({ onRouteChanged, onUiReady: handleUiReady, apiOrigin })

  // Dev-SPA mode only: a load failure means the dev server is down.
  // Unmounting `BridgedWebView` tears its transport down; clearing
  // `loadError` on retry remounts it, which reloads the page from scratch.
  if (devSpaUrl !== undefined && loadError !== null) {
    return (
      <DevServerUnreachable
        devSpaUrl={devSpaUrl}
        description={loadError.nativeEvent.description}
        onRetry={() => setLoadError(null)}
      />
    )
  }

  return (
    <BridgedWebView
      bindings={bindings}
      loadFrom={loadFrom}
      shouldOpenInSystemBrowser={shouldOpenInSystemBrowser}
      onError={devSpaUrl !== undefined ? setLoadError : undefined}
    />
  )
}

export { AppShellWebView }
export type { AppShellWebViewProps }
