import { Effect } from 'effect'

import { HostBindings, type Logging, type BridgeTransport } from 'effect-messaging-core'
import { useLogHostBinding } from 'effect-messaging-expo'

import { type AppsBridge } from 'apps-core/bridge'
import { AppsBridgeExpo } from 'apps-expo'
import { useCollectorHostBinding } from 'collector-expo'
import { type CollectorBridge } from 'collector-fundamentals/bridge'
import { type GatekeeperBridge } from 'gatekeeper-core/bridge'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { type NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useMemo } from 'react'
import { useWildflowerStore } from '@/src/livestore/livestore-store.ts'
import { useNavigationSenderRef } from './navigation-pipe.ts'

type NavigationSender = BridgeTransport.MessageSender<readonly [typeof NavigationBridge], 'Host'>

const useNavigationHostBinding = (
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void,
  onUIReady: () => void
): HostBindings.HostBindings<readonly [typeof NavigationBridge]> => {
  const navigationSenderRef = useNavigationSenderRef()

  const navigationBindingArgs = useMemo(() => {
    return {
      onRouteChanged,
      onUIReady,
      onTransportReady: (send: NavigationSender) =>
        Effect.sync(() => {
          navigationSenderRef.current = send
        }),
      initialRoute: '/apps',
    }
  }, [onRouteChanged, onUIReady, navigationSenderRef])

  const navigationBinding = NavigationBridgeExpo.useHostBinding(navigationBindingArgs)

  return navigationBinding
}

export const useHostBindings = ({
  onRouteChanged,
  onUIReady,
}: {
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
  /**
   * Fires once the embedded SPA posts `UIReady` (auth gate passed +
   * startup prefetches settled). The shell hides the native splash /
   * reveals the WebView here.
   */
  onUIReady: () => void
}): HostBindings.HostBindings<
  readonly [
    typeof NavigationBridge,
    typeof GatekeeperBridge,
    typeof CollectorBridge,
    typeof AppsBridge,
    typeof Logging.LogBridge,
  ]
> => {
  const store = useWildflowerStore()
  // `localClientToken` is passed to gatekeeper's host binding so the
  // embedded SPA is authenticated on first load. `null` while bootstrap
  // is still in flight or the mint failed.
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)
  const token = localClientToken ?? undefined

  const navigationBinding = useNavigationHostBinding(onRouteChanged, onUIReady)
  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = useCollectorHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ store })
  const logBinding = useLogHostBinding()

  return useMemo(() => {
    const bindings = HostBindings.combine([
      navigationBinding,
      gatekeeperBinding,
      collectorBinding,
      appsBinding,
      logBinding,
    ] as const)
    return bindings
  }, [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding])
}
