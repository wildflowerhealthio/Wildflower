import AppsBridge from 'apps-core/bridge'
import { Layer } from 'effect'
import type { SliceHostBinding } from 'effect-messaging-core'
import { useMemo } from 'react'
import type { TunnelStore } from 'tunnel-core/livestore'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseAppsHostBindingOptions {
  /**
   * Discharges the `TunnelStore` Tag the underlying receiver layer
   * needs. Hosts construct this via `TunnelStore.layerFrom(store)` —
   * passing the wildflower-expo livestore — and memoize it so the
   * binding identity stays stable.
   */
  readonly tunnelStoreLayer: Layer.Layer<TunnelStore>
}

/**
 * Build a {@link SliceHostBinding} for the apps bridge. Discharges the
 * receiver layer's `TunnelStore` requirement against the caller-
 * supplied store layer so the binding's `receiverLayer` requires no
 * external context.
 *
 * `BareSender` is *not* a layer-build dependency — the bridge
 * transport's dispatch fiber provides it per handler invocation, so
 * the `RequestTunnel` handler's `AppsBridge.Host.send(...)` reply
 * resolves automatically.
 */
const useAppsHostBinding = ({
  tunnelStoreLayer,
}: UseAppsHostBindingOptions): SliceHostBinding<typeof AppsBridge> =>
  useMemo(
    () => ({
      bridge: AppsBridge,
      receiverLayer: ReceiverLayer().pipe(Layer.provide(tunnelStoreLayer)),
    }),
    [tunnelStoreLayer]
  )

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
