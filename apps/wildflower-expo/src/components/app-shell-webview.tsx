import { AppsBridgeExpo } from 'apps-expo'
import { useCollectorHostBinding } from 'collector-expo'
import { Effect, Layer } from 'effect'
import type { BridgeTransport, HostBinding } from 'effect-messaging-core'
import { BridgedWebView, useLogHostBinding } from 'effect-messaging-expo'
import { Loader } from 'expo-tundraish'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { localOrigin$ } from 'local-http-server-core/livestore'
import { NavigationBridge } from 'navigation-core'
import { useMemo, type JSX } from 'react'
import { html } from 'wildflower-react/embeddable-html'
import { tabForPath } from '@/src/components/tab-mapping.ts'
import { useWildflowerStore } from '../livestore/livestore-store.ts'
import { useNavigationSenderRef } from './navigation-pipe.ts'

interface AppShellWebViewProps {
  /** Fires every time the SPA emits `RouteChanged`. */
  readonly onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
}

type NavigationSender = BridgeTransport.MessageSender<readonly [typeof NavigationBridge], 'Host'>

/**
 * The persistent shell that hosts the wildflower-react SPA. Aggregates
 * one host binding per slice and hands the tuple to {@link BridgedWebView}.
 *
 * Wires the navigation binding's `onTransportReady` into the surrounding
 * {@link useAsNavigationSource} pipe, so a sibling tab bar can dispatch
 * `HostRequestedWebNavigation` through the same transport.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
const AppShellWebView = ({ onRouteChanged }: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  // The embedded SPA always loads against the loopback origin so its
  // API calls hit `127.0.0.1` directly.
  const loopbackBaseUrl = store.useQuery(localOrigin$)
  // `localClientToken` is passed to gatekeeper's host binding so the
  // embedded SPA is authenticated on first load. `null` while bootstrap
  // is still in flight or the mint failed.
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)
  const token = localClientToken ?? undefined

  const navigationSenderRef = useNavigationSenderRef()

  const navigationBinding: HostBinding.HostBinding<typeof NavigationBridge> = useMemo(() => {
    return {
      bridge: NavigationBridge,
      receiverLayer: Layer.succeed(NavigationBridge.Host.HandlerTag, {
        RouteChanged: ({ pathname, canGoBack }) =>
          Effect.sync(() => onRouteChanged?.({ pathname, canGoBack })),
      }),
      onTransportReady: (send: NavigationSender) =>
        Effect.sync(() => {
          navigationSenderRef.current = send
        }),
      initialMessages: [
        // Navigate to the "Apps" tab on first load so the SPA's initial route is
        { _tag: 'HostRequestedWebNavigation', path: '/apps' },
      ],
    }
  }, [navigationSenderRef, onRouteChanged])

  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = useCollectorHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ store })
  const logBinding = useLogHostBinding()

  const loadFrom = useMemo(
    () => ({ _tag: 'html', html, baseUrl: loopbackBaseUrl }) as const,
    [loopbackBaseUrl]
  )

  // Memoize the tuple so `BridgedWebView`'s transport doesn't rebuild on
  // every render — the component's contract requires stable `bindings`
  // identity (see its TSDoc). Bridge ordering matches the page-side
  // tuple in `wildflower-react`'s transport provider.
  const bindings = useMemo(
    () =>
      [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding] as const,
    [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding]
  )

  const shouldOpenInSystemBrowser = (urlString: string): boolean => {
    // Open external links in the system browser; keep same-origin links in the WebView.
    try {
      const url = new URL(urlString)
      const loopbackUrl = new URL(loopbackBaseUrl)

      if (url.origin !== loopbackUrl.origin) return true
      const isRootPath = url.pathname === '' || url.pathname === '/'
      const isTabbedPath = tabForPath(url.pathname) !== null
      if (isRootPath || isTabbedPath) return false

      return true
    } catch {
      // If URL parsing fails, be conservative and open in the system browser.
      return true
    }
  }

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
