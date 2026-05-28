import { Effect } from 'effect'

import { type LogBridge, type HostBinding, type BridgeTransport } from 'effect-messaging-core'
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
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
): HostBinding.HostBinding<typeof NavigationBridge> => {
  const navigationSenderRef = useNavigationSenderRef()

  const navigationBinding = NavigationBridgeExpo.useHostBinding({
    onRouteChanged: ({ pathname, canGoBack }) =>
      Effect.sync(() => onRouteChanged({ pathname, canGoBack })),
    onTransportReady: (send: NavigationSender) =>
      Effect.sync(() => {
        navigationSenderRef.current = send
      }),
    initialRoute: '/apps',
  })

  return navigationBinding
}

export const useHostBindings = ({
  onRouteChanged,
}: {
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
}): [
  HostBinding.HostBinding<NavigationBridge>,
  HostBinding.HostBinding<GatekeeperBridge>,
  HostBinding.HostBinding<CollectorBridge>,
  HostBinding.HostBinding<AppsBridge>,
  HostBinding.HostBinding<LogBridge.LogBridge>,
] => {
  const store = useWildflowerStore()
  // `localClientToken` is passed to gatekeeper's host binding so the
  // embedded SPA is authenticated on first load. `null` while bootstrap
  // is still in flight or the mint failed.
  const { value: localClientToken } = store.useQuery(LocalClientToken.queries.current$)
  const token = localClientToken ?? undefined

  const navigationBinding = useNavigationHostBinding(onRouteChanged)
  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = useCollectorHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ store })
  const logBinding = useLogHostBinding()

  return useMemo(
    () =>
      [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding] as const,
    [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding]
  )
}
