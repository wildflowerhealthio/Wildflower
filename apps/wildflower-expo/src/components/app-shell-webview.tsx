import { AppsBridgeExpo } from 'apps-expo'
import { CollectorBridgeExpo } from 'collector-expo'
import type { HostBinding } from 'effect-messaging-core'
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
  /** Fires every time the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (event: { pathname: string; canGoBack: boolean }) => void
  /**
   * Native chrome rendered immediately below the WebView, inside the
   * host-messaging provider — typically a tab bar whose press handlers
   * dispatch typed messages via `useNavigationHostMessaging`.
   */
  readonly belowWebView?: ReactNode
}

/**
 * The persistent shell that hosts the wildflower-react SPA. Aggregates
 * one host binding per slice and hands the tuple to
 * {@link BridgedWebView}.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md)
 * for the architecture; per-slice policy lives in each
 * `use<Slice>HostBinding` hook.
 */
const AppShellWebView = ({
  route,
  baseUrl,
  token,
  onRouteChanged,
  belowWebView,
}: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  const tunnelStoreLayer = useMemo(() => TunnelStore.layerFrom(store), [store])

  const loadFrom = useMemo(() => {
    const SHOULD_USE_CACHED_HTML = true
    return SHOULD_USE_CACHED_HTML ? ({ _tag: 'html', html } as const) : ({ _tag: 'uri' } as const)
  }, [])

  const navigationBinding = NavigationBridgeExpo.useHostBinding({
    initialRoute: route,
    onRouteChanged,
  })
  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = CollectorBridgeExpo.useHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ tunnelStoreLayer })

  // Each `HostBinding.HostBinding<B>` doesn't structurally unify with
  // `HostBinding.Any` under tuple → array widening; the runtime shape
  // matches exactly. See Host Bindings Explanation § "Where the Casts
  // Live" for the variance details.
  const bindings = useMemo(() => {
    const tuple = [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding]
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return tuple as unknown as ReadonlyArray<HostBinding.Any>
  }, [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding])

  return (
    <BridgedWebView
      loadFrom={loadFrom}
      baseUrl={baseUrl}
      bindings={bindings}
      loader={<Loader />}
      belowWebView={belowWebView}
    />
  )
}

export { AppShellWebView }
export type { AppShellWebViewProps }
