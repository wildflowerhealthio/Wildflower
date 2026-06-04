import { HostBindings, type Logging } from 'effect-messaging-core'
import { useLogHostBinding } from 'effect-messaging-expo'

import { type AppsBridge } from 'apps-core/bridge'
import { AppsBridgeExpo } from 'apps-expo'
import { useCollectorHostBinding } from 'collector-expo'
import { type CollectorBridge } from 'collector-fundamentals/bridge'
import { type GatekeeperBridge } from 'gatekeeper-core/bridge'
import { LocalClientToken } from 'gatekeeper-core/livestore'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { type NavigationBridge } from 'navigation-core'
import { useMemo, useRef } from 'react'

import { useWildflowerStore } from '@/src/livestore/livestore-store.ts'
import { useNavigationHostBinding } from './use-navigation-host-binding.ts'

export const useHostBindings = ({
  onRouteChanged,
  onUiReady,
}: {
  onRouteChanged: (event: { pathname: string; canGoBack: boolean }) => void
  /**
   * Fires once the embedded SPA posts `UIReady` (auth gate passed +
   * startup prefetches settled). The shell hides the native splash /
   * reveals the WebView here.
   */
  onUiReady: () => void
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

  const navigationBinding = useNavigationHostBinding(onRouteChanged, onUiReady)
  const gatekeeperBinding = GatekeeperBridgeExpo.useHostBinding({ token })
  const collectorBinding = useCollectorHostBinding()
  const appsBinding = AppsBridgeExpo.useHostBinding({ store })
  const logBinding = useLogHostBinding()

  const combined = useMemo(
    () =>
      HostBindings.combine([
        navigationBinding,
        gatekeeperBinding,
        collectorBinding,
        appsBinding,
        logBinding,
      ] as const),
    [navigationBinding, gatekeeperBinding, collectorBinding, appsBinding, logBinding]
  )

  // Pin `bridges` to the first-render combined output. `HostBindings.combine`
  // allocates a fresh `bridges` array on every call, so any upstream
  // sub-binding identity flip (e.g. `useRouter()` returning a new
  // reference, or a slice handler closing over a per-render value) would
  // otherwise change `bindings.bridges` mid-life. `BridgedWebView`'s
  // build effect is keyed on `[bridges]`; a reference flip there tears
  // down the in-flight transport, builds a fresh one with a new
  // `peerReadyGate` Deferred, and silently breaks the SPA: the page sends
  // `__Ready` exactly once per its own lifecycle, so the rebuilt
  // transport's gate never opens. Every HostToWeb push — including the
  // gatekeeper UI token — sits buffered in the closed outbox until the
  // next scope close logs
  // `[effect-messaging] outbound pump closed with N buffered message(s)
  // undelivered`. Pinning is correct because the bridge identities are
  // module-level constants (`NavigationBridge`, `GatekeeperBridge`, …)
  // — the tuple can't change at runtime. `handlers` deliberately stays
  // un-pinned so `BridgedWebView`'s registerHandlers path keeps slice
  // inbound logic up to date without disturbing the transport.
  const [pinnedBridges] = useState(() => combined.bridges)

  return useMemo(
    () => ({
      bridges: pinnedBridges,
      handlers: combined.handlers,
      initialMessages: combined.initialMessages,
      onPageReady: combined.onPageReady,
    }),
    [combined, pinnedBridges]
  )
}
