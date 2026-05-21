import { AppsBridgeExpo } from 'apps-expo'
import { CollectorBridgeExpo } from 'collector-expo'
import type { AnyHostBinding } from 'effect-messaging-core'
import { BridgedWebView } from 'effect-messaging-expo'
import { Loader } from 'expo-tundraish'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useMemo, type JSX, type ReactNode } from 'react'
import { TunnelStore } from 'tunnel-core/livestore'
import { html } from 'wildflower-react/embeddable-html'
import { useWildflowerStore } from '../livestore/livestore-store.ts'

interface AppShellWebViewProps {
  readonly baseUrl: string
  /** Initial in-SPA route, e.g. `/apps`. */
  readonly route: string
  /** Bearer token issued to the embedded SPA on boot. */
  readonly token?: string
  /**
   * Fires every time the SPA emits `RouteChanged`. Hosts use this to
   * drive native-tab active state and the back-affordance.
   */
  readonly onRouteChanged?: (event: { pathname: string; canGoBack: boolean }) => void
  /**
   * Subtree rendered as siblings of the WebView and inside the
   * `<HostMessagingProvider>` `BridgedWebView` mounts. Use for any
   * controls (tab bar, overlays) that need to call slice messaging
   * hooks like `useNavigationHostMessaging`.
   */
  readonly children?: ReactNode
}

/**
 * The persistent shell that hosts the wildflower-react SPA. Composes
 * each slice's host binding (navigation, gatekeeper, collector, apps)
 * and hands the tuple to {@link BridgedWebView}, which owns the
 * transport + `<HostMessagingProvider>` + `<EffectMessagingWebView>`
 * + initial-message aggregation + `onTransportReady` effect run.
 *
 * Slice-specific policy lives in each binding hook:
 *
 *  - `useNavigationHostBinding` carries the initial route via the
 *    URL-param channel and forwards `onRouteChanged` from the SPA.
 *  - `useGatekeeperHostBinding` dispatches the bearer token via
 *    `onTransportReady` (not URL params — token leakage hazard).
 *  - `useCollectorHostBinding` consumes the surrounding
 *    `<CollectorBridgeExpo.HostProvider>` so `RequestSniffableWebView`
 *    can push the modal route.
 *  - `useAppsHostBinding` discharges `TunnelStore.layerFrom(store)`
 *    so the `RequestTunnel` handler can flip tunnel intent and reply
 *    with the bound origin.
 *
 * The native tab bar lives in `children`, inside the provider, so its
 * press handlers can dispatch typed navigation messages via
 * `useNavigationHostMessaging`. The WebView stays mounted across tab
 * switches.
 */
const AppShellWebView = ({
  route,
  baseUrl,
  token,
  onRouteChanged,
  children,
}: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  const tunnelStoreLayer = useMemo(() => TunnelStore.layerFrom(store), [store])

  const navigationBinding = NavigationBridgeExpo.useHostBinding({
    initialRoute: route,
    onRouteChanged,
  })
  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = CollectorBridgeExpo.useHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ tunnelStoreLayer })

  // The narrow tuple `[SliceHostBinding<Nav>, SliceHostBinding<Gk>, …]`
  // doesn't structurally unify with `ReadonlyArray<AnyHostBinding>` —
  // each `SliceHostBinding<B>` widens its bridge type through
  // `bridge: B` and `Bridge.UrlParamableMessage<[B]>`, and TS doesn't
  // walk the chain. The runtime shape is exactly the structural one;
  // the `as unknown as` chain paves over the parameterised-to-structural
  // difference so the binding tuple flows into `BridgedWebView` as a
  // uniform array.
  const bindings = useMemo(() => {
    const tuple = [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding]
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return tuple as unknown as ReadonlyArray<AnyHostBinding>
  }, [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding])

  return (
    <BridgedWebView html={html} baseUrl={baseUrl} bindings={bindings} loader={<Loader />}>
      {children}
    </BridgedWebView>
  )
}

export { AppShellWebView }
export type { AppShellWebViewProps }
