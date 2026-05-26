import { AppsBridgeExpo } from 'apps-expo'
import { useCollectorHostBinding } from 'collector-expo'
import { Effect, type Layer } from 'effect'
import { type BridgeTransport, type HostBinding } from 'effect-messaging-core'
import { BridgedWebView } from 'effect-messaging-expo'
import { Loader } from 'expo-tundraish'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import type { NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useMemo, type JSX } from 'react'
import { useFunctionSafeState } from 'react-kitchen-sink'
import { TunnelStore } from 'tunnel-core/livestore'
import { html } from 'wildflower-react/embeddable-html'

import { useWildflowerStore } from '../livestore/livestore-store.ts'
import { useAsNavigationSource } from './navigation-pipe.ts'

interface AppShellWebViewProps {
  readonly baseUrl: string
  /** Initial in-SPA route, e.g. `/apps`. */
  readonly route: string
  /** Bearer token issued to the embedded SPA on boot. */
  readonly token?: string
  /** Fires every time the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (event: { pathname: string; canGoBack: boolean }) => void
}

type NavigationSender = BridgeTransport.MessageSender<readonly [typeof NavigationBridge], 'Host'>

/**
 * Logged when a navigation message is dispatched before the shell's
 * `<BridgedWebView>` has built its transport. The pipe's own
 * warn-and-drop default would suffice; this wraps it so the
 * `[AppShellWebView]` tag in logs identifies the responsible layer.
 */
const navigationNotReadySender: NavigationSender = (msg) =>
  Effect.logWarning(`[AppShellWebView] transport not ready; dropping navigation ${msg._tag}`)

/**
 * The persistent shell that hosts the wildflower-react SPA. Aggregates
 * one {@link HostBinding} per slice and hands the tuple to
 * {@link BridgedWebView}.
 *
 * The native tab bar lives as a sibling of this component (rendered
 * by the surrounding screen, e.g. `HomeScreen`). To let it dispatch
 * `HostRequestedWebNavigation` from native press handlers, this
 * component wraps `NavigationBridgeExpo.useHostBinding`'s result with
 * an `onTransportReady` that captures the transport's typed sender
 * and registers it into the surrounding `NavigationPipeProvider` via
 * {@link useAsNavigationSource}. Descendants of the pipe provider
 * (the tab bar in particular) call `useNavigationSender()` to get the
 * sender.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md)
 * for the binding contract; per-slice policy lives in each
 * `use<Slice>HostBinding` hook.
 */
const AppShellWebView = ({
  route,
  baseUrl,
  token,
  onRouteChanged,
}: AppShellWebViewProps): JSX.Element => {
  const store = useWildflowerStore()
  const tunnelStoreLayer: Layer.Layer<TunnelStore> = useMemo(
    () => TunnelStore.layerFrom(store),
    [store]
  )

  // `useFunctionSafeState` stores the sender callback verbatim — a
  // raw `useState` would interpret the function as a state updater.
  const [navigationSender, setNavigationSender] = useFunctionSafeState<NavigationSender | null>(
    null
  )

  // Plug the captured sender into the navigation pipe so the tab bar
  // sibling can dispatch through it. Falls back to the local warning
  // sender until the transport finishes building.
  useAsNavigationSource(navigationSender ?? navigationNotReadySender)

  const navigationBaseBinding = NavigationBridgeExpo.useHostBinding({
    initialRoute: route,
    onRouteChanged,
  })
  const navigationBinding = useMemo<HostBinding.HostBinding<typeof NavigationBridge>>(
    () => ({
      ...navigationBaseBinding,
      // The base hook doesn't ship `onTransportReady`; wrap so the
      // tab bar can dispatch into the same transport the shell built.
      // Storing the sender in state (rather than a ref) triggers the
      // `useAsNavigationSource` re-register on next render — without
      // it, the pipe stays on the warn-and-drop default.
      onTransportReady: (send) => Effect.sync(() => setNavigationSender(send)),
    }),
    [navigationBaseBinding, setNavigationSender]
  )

  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = useCollectorHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ tunnelStoreLayer })

  const loadFrom = useMemo(() => ({ _tag: 'html', html, baseUrl }) as const, [baseUrl])

  // Memoize the tuple so `BridgedWebView`'s transport doesn't rebuild
  // on every render — the component's contract requires stable
  // `bindings` identity (see its TSDoc).
  const bindings = useMemo(
    () => [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding] as const,
    [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding]
  )

  return <BridgedWebView bindings={bindings} loadFrom={loadFrom} loader={<Loader />} />
}

export { AppShellWebView }
export type { AppShellWebViewProps }
