import { AppsBridgeExpo } from 'apps-expo'
import { useCollectorHostBinding } from 'collector-expo'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { BridgedWebView, useLogHostBinding } from 'effect-messaging-expo'
import { Loader } from 'expo-tundraish'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { localOrigin$ } from 'local-http-server-core/livestore'
import type { NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useCallback, useMemo, type JSX } from 'react'
import { useFunctionSafeState } from 'react-kitchen-sink'
import { html } from 'wildflower-react/embeddable-html'

import { useWildflowerStore } from '../livestore/livestore-store.ts'
import { defaultNavigationSender, useAsNavigationSource } from './navigation-pipe.ts'

interface AppShellWebViewProps {
  /** Initial in-SPA route, e.g. `/apps`. */
  readonly route: string
  /** Fires every time the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (event: { pathname: string; canGoBack: boolean }) => void
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
const AppShellWebView = ({ route, onRouteChanged }: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  // The embedded SPA always loads against the loopback origin so its
  // API calls hit `127.0.0.1` directly.
  const loopbackBaseUrl = store.useQuery(localOrigin$)
  // `localClientToken` is passed to gatekeeper's host binding so the
  // embedded SPA is authenticated on first load. `null` while bootstrap
  // is still in flight or the mint failed.
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)
  const token = localClientToken ?? undefined

  // `useFunctionSafeState` stores the sender callback verbatim — a raw
  // `useState` would interpret the function as a state updater.
  const [navigationSender, setNavigationSender] = useFunctionSafeState<NavigationSender | null>(
    null
  )

  // Register the captured sender into the pipe. Until `onTransportReady`
  // fires, the pipe's built-in `defaultNavigationSender` (warn-and-drop)
  // handles any pre-transport dispatches.
  useAsNavigationSource(navigationSender ?? defaultNavigationSender)

  const onNavigationTransportReady = useCallback(
    (send: NavigationSender) => Effect.sync(() => setNavigationSender(send)),
    [setNavigationSender]
  )

  const navigationBinding = NavigationBridgeExpo.useHostBinding({
    initialRoute: route,
    onRouteChanged,
    onTransportReady: onNavigationTransportReady,
  })
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

  return <BridgedWebView bindings={bindings} loadFrom={loadFrom} loader={<Loader />} />
}

export { AppShellWebView }
export type { AppShellWebViewProps }
