import { AppsBridge } from 'apps-core/bridge'
import { Layer } from 'effect'
import { HostBindings } from 'effect-messaging-core'
import { useMemo } from 'react'
import { TunnelStore } from 'tunnel-core/livestore'
import { ReceiverLayer } from './host-receiver-layer.ts'

type TunnelLivestore = typeof TunnelStore.Service

interface UseAppsHostBindingOptions {
  /**
   * The livestore handle that owns the tunnel slice's tables. The hook
   * derives the `TunnelStore` layer internally via
   * `TunnelStore.layerFrom(store)`, so callers only need a stable
   * reference to the store (the wildflower-expo shell's
   * `useWildflowerStore()` returns one).
   */
  readonly store: TunnelLivestore
}

/**
 * Host binding for the apps bridge.
 *
 * Pre-discharges `TunnelStore` against a layer built from the supplied
 * livestore handle; the receiver layer's `RequestTunnel` handler replies
 * via `AppsBridge.Host.send(...)` (whose `TransportAdapter` requirement
 * the bridge transport's dispatch fiber discharges per invocation).
 */
const useAppsHostBinding = ({
  store,
}: UseAppsHostBindingOptions): HostBindings.HostBindings<readonly [typeof AppsBridge]> => {
  const tunnelStoreLayer = useMemo(() => TunnelStore.layerFrom(store), [store])
  return useMemo(
    () =>
      HostBindings.single({
        bridge: AppsBridge,
        receiverLayer: ReceiverLayer.pipe(Layer.provide(tunnelStoreLayer)),
      }),
    [tunnelStoreLayer]
  )
}

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
