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

/** Host binding for the apps bridge; pre-discharges `TunnelStore`. */
const useAppsHostBinding = ({
  tunnelStoreLayer,
}: UseAppsHostBindingOptions): HostBinding.HostBinding<typeof AppsBridge> =>
  useMemo(
    () => ({
      bridge: AppsBridge,
      receiverLayer: ReceiverLayer().pipe(Layer.provide(tunnelStoreLayer)),
    }),
    [tunnelStoreLayer]
  )

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
