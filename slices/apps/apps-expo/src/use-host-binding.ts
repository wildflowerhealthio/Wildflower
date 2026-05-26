import AppsBridge from 'apps-core/bridge'
import { Layer } from 'effect'
import type { HostBinding } from 'effect-messaging-core'
import { useMemo } from 'react'
import type { TunnelStore } from 'tunnel-core/livestore'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseAppsHostBindingOptions {
  /**
   * Discharges the `TunnelStore` Tag the receiver layer needs. Hosts
   * construct this via `TunnelStore.layerFrom(store)` and memoize it.
   */
  readonly tunnelStoreLayer: Layer.Layer<TunnelStore>
}

/**
 * Host binding for the apps bridge.
 *
 * Pre-discharges `TunnelStore` against the supplied layer; the receiver
 * layer's `RequestTunnel` handler replies via `AppsBridge.Host.send(...)`
 * (whose `TransportAdapter` requirement the bridge transport's dispatch
 * fiber discharges per invocation).
 */
const useAppsHostBinding = ({
  tunnelStoreLayer,
}: UseAppsHostBindingOptions): HostBinding.HostBinding<typeof AppsBridge> =>
  useMemo(
    () => ({
      bridge: AppsBridge,
      receiverLayer: ReceiverLayer.pipe(Layer.provide(tunnelStoreLayer)),
    }),
    [tunnelStoreLayer]
  )

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
